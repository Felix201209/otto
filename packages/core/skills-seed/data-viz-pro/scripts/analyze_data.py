#!/usr/bin/env python3
"""
Data-Viz-Pro analysis planner.

Reads a CSV/XLSX dataset, profiles fields, extracts practical insights, and
emits chart JSON configs that can be rendered by create_chart.py.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any


MAX_INPUT_ROWS = 200_000
MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_CHART_POINTS = 20_000


def _die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def _dependency_install_hint() -> str:
    requirements = Path(__file__).resolve().parent.parent / "requirements.txt"
    return (
        f'`python3 -m pip install -r "{requirements}"` '
        f'(Windows: `py -3 -m pip install -r "{requirements}"`).'
    )


def _import_pandas():
    try:
        import pandas as pd

        return pd
    except ImportError:
        _die(
            "pandas is required. Install all skill dependencies with "
            f"{_dependency_install_hint()}"
        )


def _enforce_row_limit(df, path: Path):
    if len(df) > MAX_INPUT_ROWS:
        _die(
            f"{path.name} exceeds the {MAX_INPUT_ROWS:,}-row safety limit. "
            "Filter or aggregate the data before rendering."
        )
    return df


def _read_table(path: Path):
    if not path.is_file():
        _die(f"Input file does not exist: {path}")
    if path.stat().st_size > MAX_INPUT_BYTES:
        _die(
            f"{path.name} exceeds the {MAX_INPUT_BYTES // (1024 * 1024)} MB "
            "input safety limit."
        )

    pd = _import_pandas()
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        return _enforce_row_limit(
            pd.read_excel(path, nrows=MAX_INPUT_ROWS + 1),
            path,
        )
    if suffix in {".csv", ".txt"}:
        encodings = ["utf-8-sig", "utf-8", "gb18030", "gbk"]
        last_error: Exception | None = None
        for encoding in encodings:
            try:
                return _enforce_row_limit(
                    pd.read_csv(
                        path,
                        encoding=encoding,
                        nrows=MAX_INPUT_ROWS + 1,
                    ),
                    path,
                )
            except UnicodeDecodeError as exc:
                last_error = exc
        raise last_error or ValueError("Could not read CSV")
    if suffix in {".tsv"}:
        return _enforce_row_limit(
            pd.read_csv(path, sep="\t", nrows=MAX_INPUT_ROWS + 1),
            path,
        )
    _die(f"Unsupported file type: {suffix}. Use CSV, TSV, XLS, or XLSX.")


def _safe_name(text: str) -> str:
    text = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", str(text), flags=re.UNICODE)
    text = re.sub(r"_+", "_", text).strip("_")
    return text[:60] or "chart"


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    except Exception:
        return None


def _round(value: Any, digits: int = 2) -> float | int | None:
    number = _to_float(value)
    if number is None:
        return None
    rounded = round(number, digits)
    if abs(rounded - int(rounded)) < 1e-9:
        return int(rounded)
    return rounded


def _classify_columns(df):
    pd = _import_pandas()
    numeric_cols = [
        c for c in df.columns
        if pd.api.types.is_numeric_dtype(df[c]) and df[c].notna().sum() > 0
    ]
    categorical_cols = []
    date_cols = []
    for col in df.columns:
        if col in numeric_cols:
            continue
        series = df[col].dropna()
        if series.empty:
            continue
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                parsed = pd.to_datetime(series, errors="coerce")
            if parsed.notna().mean() >= 0.8:
                date_cols.append(col)
                continue
        except Exception:
            pass
        unique_count = series.nunique()
        if unique_count <= max(20, len(df) * 0.5):
            categorical_cols.append(col)
    return numeric_cols, categorical_cols, date_cols


def _metric_columns(df, numeric_cols):
    """Exclude identifiers/ranks from primary metric recommendations."""
    excluded_name_pattern = re.compile(
        r"(id|编号|序号|学号|工号|订单号|单号|排名|rank|index|code|编码)",
        re.IGNORECASE,
    )
    metrics = []
    for col in numeric_cols:
        name = str(col)
        if excluded_name_pattern.search(name):
            continue
        s = df[col].dropna()
        if s.empty:
            continue
        unique_ratio = s.nunique() / max(len(s), 1)
        integer_like = all(float(v).is_integer() for v in s.head(50))
        long_integer = integer_like and s.astype(str).str.len().median() >= 6
        if unique_ratio > 0.92 and long_integer:
            continue
        metrics.append(col)
    return metrics or numeric_cols


def _dataset_profile(df, numeric_cols, metric_cols, categorical_cols, date_cols):
    profile = {
        "rows": int(len(df)),
        "columns": int(len(df.columns)),
        "column_names": [str(c) for c in df.columns],
        "numeric_columns": [str(c) for c in numeric_cols],
        "metric_columns": [str(c) for c in metric_cols],
        "categorical_columns": [str(c) for c in categorical_cols],
        "date_columns": [str(c) for c in date_cols],
        "missing_cells": int(df.isna().sum().sum()),
    }
    numeric_summary = {}
    for col in numeric_cols:
        s = df[col].dropna()
        numeric_summary[str(col)] = {
            "mean": _round(s.mean()),
            "median": _round(s.median()),
            "min": _round(s.min()),
            "max": _round(s.max()),
            "std": _round(s.std()),
        }
    profile["numeric_summary"] = numeric_summary
    return profile


def _top_count_chart(df, cat_col):
    counts = df[cat_col].dropna().astype(str).value_counts().head(10)
    if counts.empty:
        return None
    return {
        "type": "bar",
        "title": f"{cat_col}集中在{counts.index[0]}，Top10类别对比",
        "subtitle": "按记录数排序",
        "ylabel": "记录数",
        "theme": "cool",
        "data": {
            "x_labels": [str(x) for x in counts.index],
            "series": [{"name": "记录数", "values": [int(v) for v in counts.values]}],
        },
        "x_rotation": 25,
    }


def _bar_by_category_chart(df, cat_col, num_col):
    clean = df[[cat_col, num_col]].dropna(subset=[cat_col, num_col])
    grouped = (
        clean.groupby(cat_col, observed=True)[num_col]
        .mean()
        .sort_values(ascending=False)
        .head(10)
    )
    if grouped.empty:
        return None
    top_label = str(grouped.index[0])
    top_value = _round(grouped.iloc[0], 1)
    return {
        "type": "bar",
        "title": f"{cat_col}中{top_label}的{num_col}均值最高（{top_value}）",
        "subtitle": f"按{num_col}均值排序，展示Top10",
        "ylabel": f"{num_col}均值",
        "theme": "cool",
        "data": {
            "x_labels": [str(x) for x in grouped.index],
            "series": [{"name": str(num_col), "values": [_round(v, 1) for v in grouped.values]}],
        },
        "x_rotation": 25,
    }


def _hist_chart(df, num_col):
    clean = df[num_col].dropna()
    if len(clean) > MAX_CHART_POINTS:
        clean = clean.sample(n=MAX_CHART_POINTS, random_state=0)
    values = [_round(v, 2) for v in clean.tolist()]
    if len(values) < 5:
        return None
    return {
        "type": "histogram",
        "title": f"{num_col}主要集中在{_round(df[num_col].median(), 1)}附近",
        "subtitle": "分布形态与离群点观察",
        "xlabel": str(num_col),
        "ylabel": "频次",
        "theme": "slate",
        "data": {"values": values, "bins": min(12, max(6, int(math.sqrt(len(values)))))},
    }


def _scatter_chart(df, x_col, y_col):
    clean = df[[x_col, y_col]].dropna()
    if len(clean) < 5:
        return None
    if len(clean) > MAX_CHART_POINTS:
        clean = clean.sample(n=MAX_CHART_POINTS, random_state=0)
    corr = clean[x_col].corr(clean[y_col])
    return {
        "type": "scatter",
        "title": f"{x_col}与{y_col}相关系数为{_round(corr, 2)}",
        "subtitle": "用于观察相关性、聚类和异常点",
        "xlabel": str(x_col),
        "ylabel": str(y_col),
        "theme": "dark",
        "data": {
            "series": [{
                "name": "样本",
                "x": [_round(v, 2) for v in clean[x_col].tolist()],
                "y": [_round(v, 2) for v in clean[y_col].tolist()],
            }],
        },
    }


def _line_chart(df, date_col, num_col):
    pd = _import_pandas()
    work = df[[date_col, num_col]].copy()
    work[date_col] = pd.to_datetime(work[date_col], errors="coerce")
    work = work.dropna().sort_values(date_col)
    if len(work) < 3:
        return None
    grouped = work.groupby(work[date_col].dt.strftime("%Y-%m"), observed=True)[num_col].mean()
    if len(grouped) < 3:
        grouped = work.groupby(work[date_col].dt.strftime("%Y-%m-%d"), observed=True)[num_col].mean()
    if len(grouped) > MAX_CHART_POINTS:
        grouped = grouped.tail(MAX_CHART_POINTS)
    return {
        "type": "line",
        "title": f"{num_col}随时间变化，最新值为{_round(grouped.iloc[-1], 1)}",
        "subtitle": f"按{date_col}聚合",
        "ylabel": str(num_col),
        "theme": "cool",
        "data": {
            "x_labels": [str(x) for x in grouped.index],
            "series": [{"name": str(num_col), "values": [_round(v, 1) for v in grouped.values]}],
            "smooth": False,
            "fill": True,
        },
        "x_rotation": 25,
    }


def _insights(df, numeric_cols, categorical_cols):
    insights = []
    if df.isna().sum().sum() > 0:
        missing = df.isna().sum().sort_values(ascending=False)
        top_missing = missing[missing > 0].head(3)
        insights.append("存在缺失值：" + "、".join(f"{k}缺{int(v)}个" for k, v in top_missing.items()))
    for col in numeric_cols[:6]:
        s = df[col].dropna()
        if s.empty:
            continue
        insights.append(
            f"{col}：均值{_round(s.mean(), 1)}，中位数{_round(s.median(), 1)}，范围{_round(s.min(), 1)}到{_round(s.max(), 1)}。"
        )
        q1, q3 = s.quantile(0.25), s.quantile(0.75)
        iqr = q3 - q1
        if iqr > 0:
            outliers = s[(s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)]
            if len(outliers) > 0:
                insights.append(f"{col}发现{len(outliers)}个统计离群点，建议在图中标注或单独核对。")
    for col in categorical_cols[:4]:
        counts = df[col].dropna().astype(str).value_counts().head(3)
        if len(counts):
            insights.append(f"{col}Top类别：" + "、".join(f"{k}({int(v)})" for k, v in counts.items()))
    return insights[:10]


def recommend_charts(df, numeric_cols, categorical_cols, date_cols):
    metric_cols = _metric_columns(df, numeric_cols)
    charts = []
    if categorical_cols:
        chart = _top_count_chart(df, categorical_cols[0])
        if chart:
            charts.append(("category_count", chart))
    if categorical_cols and metric_cols:
        chart = _bar_by_category_chart(df, categorical_cols[0], metric_cols[0])
        if chart:
            charts.append(("category_numeric", chart))
    if metric_cols:
        chart = _hist_chart(df, metric_cols[0])
        if chart:
            charts.append(("distribution", chart))
    if len(metric_cols) >= 2:
        best = None
        best_score = -1.0
        for i, left in enumerate(metric_cols):
            for right in metric_cols[i + 1:]:
                corr = abs(df[left].corr(df[right]))
                if not math.isnan(corr) and corr > best_score:
                    best = (left, right)
                    best_score = corr
        if best:
            chart = _scatter_chart(df, best[0], best[1])
            if chart:
                charts.append(("correlation", chart))
    if date_cols and metric_cols:
        chart = _line_chart(df, date_cols[0], metric_cols[0])
        if chart:
            charts.insert(0, ("trend", chart))
    return charts[:6]


def write_outputs(input_path: Path, output_dir: Path, render: bool):
    df = _read_table(input_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    manifest_path.unlink(missing_ok=True)
    numeric_cols, categorical_cols, date_cols = _classify_columns(df)
    metric_cols = _metric_columns(df, numeric_cols)
    profile = _dataset_profile(df, numeric_cols, metric_cols, categorical_cols, date_cols)
    insights = _insights(df, metric_cols, categorical_cols)
    charts = recommend_charts(df, numeric_cols, categorical_cols, date_cols)

    profile_path = output_dir / "profile.json"
    profile_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")

    report_lines = [
        "# 数据可视化自动分析报告",
        "",
        f"- 数据文件：{input_path}",
        f"- 行数：{profile['rows']}",
        f"- 列数：{profile['columns']}",
        f"- 数值字段：{', '.join(profile['numeric_columns']) or '无'}",
        f"- 推荐指标字段：{', '.join(profile['metric_columns']) or '无'}",
        f"- 类别字段：{', '.join(profile['categorical_columns']) or '无'}",
        f"- 日期字段：{', '.join(profile['date_columns']) or '无'}",
        "",
        "## 关键发现",
    ]
    report_lines.extend(f"- {item}" for item in (insights or ["暂无足够字段形成稳定结论。"]))
    report_lines.extend(["", "## 推荐图表"])

    manifest = {"input": str(input_path), "profile": str(profile_path), "charts": []}
    rendered_paths: list[Path] = []
    for index, (name, cfg) in enumerate(charts, start=1):
        file_stem = f"{index:02d}_{_safe_name(name)}"
        cfg_path = output_dir / f"{file_stem}.json"
        cfg["source"] = input_path.name
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        item = {"name": name, "config": str(cfg_path), "title": cfg.get("title", "")}
        if render:
            png_path = output_dir / f"{file_stem}.png"
            svg_path = png_path.with_suffix(".svg")
            png_path.unlink(missing_ok=True)
            svg_path.unlink(missing_ok=True)
            script = Path(__file__).with_name("create_chart.py")
            result = subprocess.run(
                [sys.executable, str(script), str(cfg_path), str(png_path)],
                check=False,
                capture_output=True,
                text=True,
            )
            invalid_outputs = [
                path
                for path in (png_path, svg_path)
                if not path.is_file() or path.stat().st_size == 0
            ]
            if result.returncode != 0 or invalid_outputs:
                for path in [*rendered_paths, png_path, svg_path]:
                    path.unlink(missing_ok=True)
                detail = (result.stderr or result.stdout or "").strip()
                if result.returncode != 0:
                    message = (
                        f"Chart renderer failed for {cfg_path.name} "
                        f"(exit {result.returncode})"
                    )
                else:
                    missing = ", ".join(path.name for path in invalid_outputs)
                    message = (
                        f"Chart renderer did not create non-empty output(s) "
                        f"for {cfg_path.name}: {missing}"
                    )
                _die(f"{message}. {detail}".strip())
            rendered_paths.extend((png_path, svg_path))
            item["png"] = str(png_path)
            item["svg"] = str(svg_path)
        manifest["charts"].append(item)
        report_lines.append(f"- {cfg.get('title', name)}：`{cfg_path.name}`")

    report_path = output_dir / "analysis_report.md"
    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    manifest["report"] = str(report_path)

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Analyze data and recommend publication-ready charts.")
    parser.add_argument("input", help="CSV/TSV/XLS/XLSX data file")
    parser.add_argument("output_dir", help="Directory for report and chart configs")
    parser.add_argument("--render", action="store_true", help="Also render PNG/SVG charts with create_chart.py")
    args = parser.parse_args()
    write_outputs(Path(args.input), Path(args.output_dir), args.render)


if __name__ == "__main__":
    main()
