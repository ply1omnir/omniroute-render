# OmniRoute on Render — 部署镜像
#
# 本仓库只包含"部署脚手架"，不含任何密钥。
# 所有密钥（JWT_SECRET / API_KEY_SECRET / INITIAL_PASSWORD / GITHUB_TOKEN）
# 一律通过 Render 的 Environment Variables 注入，绝不进入本仓库。
#
# 说明：此处先用最小可用版本验证 Render 免费档的构建链路；
# supervisor（冷启动还原 + 后台快照 + 控制端点）将在确认构建可用后加入。

FROM diegosouzapw/omniroute:latest

# OmniRoute 的数据目录；容器文件系统是临时的，启动时由 supervisor 还原
ENV DATA_DIR=/app/data

# Render 会注入 PORT（默认 10000），OmniRoute 的 run-standalone 会读取它，
# 并把 API_PORT / DASHBOARD_PORT 自动跟随到同一端口。
ENV HOSTNAME=0.0.0.0

# 注意：Render 控制台里必须把 Health Check Path 留空（使用默认 TCP 探测）。
# 免费实例上 /healthz 常态就要 0.95-1.9 秒，HTTP 健康检查的 5 秒超时
# 曾在实测中把实例判死并导致服务停在 502。

EXPOSE 10000
