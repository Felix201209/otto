# Git Headers 子目录兜底方案 — 服务端兼容性确认

## 背景

Otto 当前会为内部员工（猎豹域名邮箱）在 API 请求中附带 git 仓库信息，用于服务端的使用管理。相关 headers：

- `X-Git-Remotes` — git 远程仓库地址
- `X-Git-Branch` — 当前分支名

## 问题

部分员工的使用习惯是：把多个项目放在同一个父文件夹下，然后在**父文件夹**中启动 Otto 进行跨项目的综合分析和修改。例如：

```
D:\work\                  ← 员工在这里启动 Otto（不是 git 仓库）
├── project-a\            ← git 仓库
├── project-b\            ← git 仓库
└── project-c\            ← git 仓库
```

这种情况下，当前工作目录（`D:\work\`）本身没有 git 信息，导致请求中不带 `X-Git-Remotes` / `X-Git-Branch`，被服务端拒绝服务。

## 客户端方案

我们已在客户端做了兜底处理：**当前目录获取不到 git 信息时，扫描下一级子目录，收集所有子目录中的 git 仓库信息一并发送。**

这会导致 header 格式出现两种情况：

### 情况一：当前目录本身是 git 仓库（原有格式，不变）

```
X-Git-Remotes: {"origin":"https://github.com/org/repo.git"}
X-Git-Branch: main
```

### 情况二：当前目录不是 git 仓库，子目录中包含 git 仓库（新增格式）

```
X-Git-Remotes: {"project-a":{"origin":"https://github.com/org/project-a.git"},"project-b":{"origin":"https://gitlab.com/org/project-b.git"}}
X-Git-Branch: {"project-a":"main","project-b":"develop"}
```

区别：
- **情况一**：`X-Git-Remotes` 的 value 是 `{remoteName: url}` 单层结构，`X-Git-Branch` 是纯字符串
- **情况二**：`X-Git-Remotes` 的 value 是 `{dirName: {remoteName: url}}` 嵌套结构，`X-Git-Branch` 也变为 JSON 对象 `{dirName: branch}`

## 需要服务端确认的问题

1. **格式兼容性**：服务端解析 `X-Git-Remotes` 时是否有严格的 schema 校验？能否兼容上述两种 JSON 结构（单层 vs 嵌套）？

2. **判断逻辑**：服务端当前的"必须带有 git 信息"校验，是只检查 header 是否存在，还是会解析里面的内容做进一步校验？如果会解析，需要适配新格式。

3. **多仓库场景的权限**：情况二中一次请求会带上多个仓库的地址，服务端的权限/审计逻辑是否能正常处理？比如是按"至少有一个合法仓库就放行"还是"所有仓库都必须合法"？

4. **是否需要区分标识**：是否需要客户端额外加一个 header（比如 `X-Git-Mode: subdirectory`）来明确告知服务端当前是哪种情况，方便你们做分支处理？

---

请评估后回复，我们根据结论做最终调整。
