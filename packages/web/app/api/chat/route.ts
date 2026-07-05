export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const OTTO_DIR = "/Users/king/Desktop/我的文件/项目/otto";
const OTTO_BIN = OTTO_DIR + "/bundle/otto.js";

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  if (!message) return NextResponse.json({ reply: "请输入指令" }, { status: 400 });

  try {
    const result = await execAsync(
      `node "${OTTO_BIN}" -p "${message.replace(/"/g, '\\"')}"`,
      { cwd: OTTO_DIR, timeout: 30000, env: { ...process.env, OTTO_CONFIG_DIR: process.env.HOME + "/.otto" } }
    );
    const clean = (result.stdout + result.stderr)
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\[ERR\]/g, "")
      .trim();
    return NextResponse.json({ reply: clean || "处理完成", stats: { tasks: 1, saved: 0.1, tokens: 500 } });
  } catch (e: any) {
    return NextResponse.json({ reply: "Otto引擎: " + (e.message || "连接失败"), stats: { tasks: 0, saved: 0, tokens: 0 } });
  }
}
