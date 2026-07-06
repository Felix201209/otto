#!/usr/bin/env python3
"""
OR-Tools 任务分配优化服务。

作为 taskOrchestrator.ts 的数学优化层：
LLM 决策负责"谁适合干什么"（语义层），OR-Tools 负责"在约束下最优分配"（数学层）。

启动后监听 localhost:7777，暴露 POST /optimize 接口。

依赖：pip install ortools flask
"""

import json
from flask import Flask, request, jsonify
from ortools.sat.python import cp_model

app = Flask(__name__)


@app.route('/optimize', methods=['POST'])
def optimize_allocation():
    """
    输入：
    {
      "tasks": [{"id": "t1", "priority": 3, "estimated_minutes": 30, "required_skills": ["python"]}],
      "employees": [{"id": "e1", "skills": ["python", "sql"], "current_load": 40, "efficiency": 80}],
      "constraints": {"max_tasks_per_person": 3, "balance_threshold": 20}
    }

    输出：
    {
      "assignments": [{"task_id": "t1", "employee_id": "e1", "score": 85}],
      "load_balance": {"e1": 30, "e2": 45},
      "explanation": "..."
    }
    """
    data = request.json
    tasks = data.get('tasks', [])
    employees = data.get('employees', [])
    constraints = data.get('constraints', {})

    if not tasks or not employees:
        return jsonify({"error": "tasks and employees required"}), 400

    max_tasks = constraints.get('max_tasks_per_person', 5)
    balance_threshold = constraints.get('balance_threshold', 30)

    # 构建 CP-SAT 模型
    model = cp_model.CpModel()

    # 变量：assign[t][e] = 1 表示任务 t 分配给员工 e
    assign = {}
    for t in tasks:
        for e in employees:
            assign[(t['id'], e['id'])] = model.NewBoolVar(f'assign_{t["id"]}_{e["id"]}')

    # 约束1：每个任务必须分配给恰好一个人
    for t in tasks:
        model.Add(sum(assign[(t['id'], e['id'])] for e in employees) == 1)

    # 约束2：每人最多分配 max_tasks 个任务
    for e in employees:
        model.Add(sum(assign[(t['id'], e['id'])] for t in tasks) <= max_tasks)

    # 约束3：负载均衡（每人总任务时长不超过平均值 + threshold）
    total_minutes = sum(t.get('estimated_minutes', 30) for t in tasks)
    avg_minutes = total_minutes / len(employees) if employees else 0
    max_allowed = int(avg_minutes + balance_threshold)

    for e in employees:
        total_for_e = sum(
            assign[(t['id'], e['id'])] * t.get('estimated_minutes', 30)
            for t in tasks
        )
        model.Add(total_for_e <= max_allowed)

    # 目标：最大化总分（技能匹配 + 效率 - 负载惩罚）
    objective_terms = []
    for t in tasks:
        priority = t.get('priority', 1)
        req_skills = set(t.get('required_skills', []))
        for e in employees:
            # 技能匹配分
            emp_skills = set(e.get('skills', []))
            skill_match = len(req_skills & emp_skills) * 10

            # 效率分
            efficiency = e.get('efficiency', 50)

            # 负载惩罚（负载越高越不倾向于分配）
            load_penalty = e.get('current_load', 0) // 5

            # 综合分
            score = (skill_match + efficiency - load_penalty) * priority
            objective_terms.append(assign[(t['id'], e['id'])] * score)

    model.Maximize(sum(objective_terms))

    # 求解
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 5.0  # 5秒超时
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return jsonify({"error": "No feasible solution found"}), 500

    # 提取结果
    assignments = []
    load_map = {e['id']: 0 for e in employees}

    for t in tasks:
        for e in employees:
            if solver.Value(assign[(t['id'], e['id'])]):
                req_skills = set(t.get('required_skills', []))
                emp_skills = set(e.get('skills', []))
                skill_match = len(req_skills & emp_skills)
                score = skill_match * 10 + e.get('efficiency', 50) - e.get('current_load', 0) // 5

                assignments.append({
                    "task_id": t['id'],
                    "employee_id": e['id'],
                    "score": max(0, score),
                    "skill_match": skill_match,
                })
                load_map[e['id']] += t.get('estimated_minutes', 30)

    # 生成解释
    explanations = []
    for a in assignments:
        explanations.append(
            f"Task {a['task_id']} → {a['employee_id']} "
            f"(score={a['score']}, skills matched={a['skill_match']})"
        )

    return jsonify({
        "assignments": assignments,
        "load_balance": load_map,
        "explanation": "\n".join(explanations),
        "optimal": status == cp_model.OPTIMAL,
    })


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "ortools-allocator"})


if __name__ == '__main__':
    print("OR-Tools Task Allocator running on http://localhost:7777")
    print("  POST /optimize - Optimize task allocation")
    print("  GET  /health   - Health check")
    app.run(host='127.0.0.1', port=7777, debug=False)
