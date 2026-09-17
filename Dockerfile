# OmniRoute on Render — 部署镜像
#
# 本仓库只包含"部署脚手架"，不含任何密钥。
# 所有密钥（JWT_SECRET / API_KEY_SECRET / INITIAL_PASSWORD / GITHUB_TOKEN /
# CONTROL_TOKEN）一律通过 Render 的 Environment Variables 注入，绝不进入本仓库。
#
# 组成：
#   supervisor.mjs     容器入口 —— 冷启动还原 + 反向代理 + 窄控制端点 + 定时快照
#   snapshot-core.mjs  快照逻辑（在 supervisor 进程内运行，不额外起 Node 进程）
#   github.mjs         GitHub Releases 读写封装
#
# ★ 快照为什么必须同进程：实测在 512Mi 实例上，多起一个 Node 子进程做快照
#   会把容器撑爆，被 Render OOM 杀掉（server_failed / oomKilled 512Mi）。

FROM diegosouzapw/omniroute:latest

# OmniRoute 的数据目录。容器文件系统是临时的，
# 每次冷启动都由 supervisor 从私有仓库的最新快照还原。
ENV DATA_DIR=/app/data
ENV HOSTNAME=0.0.0.0

# 注意：Render 控制台里必须把 Health Check Path 留空（使用默认 TCP 探测）。
# 实测证据：免费实例上 /healthz 常态 0.95-1.9 秒，HTTP 健康检查的 5 秒超时
# 曾把实例判死（evicted:false）并导致服务停在 502 且不自动恢复。

COPY --chown=node:node supervisor.mjs snapshot-core.mjs github.mjs /app/

CMD ["node", "/app/supervisor.mjs"]
