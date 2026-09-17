# omniroute-render

OmniRoute 在 Render 免费档上的**部署脚手架仓库**。

- 本仓库**只放部署用代码**，不含任何密钥。
- 密钥通过 Render 的 Environment Variables 注入。
- 配置数据的持久化使用另一个**私有**仓库的 Releases 资产（本仓库不保存数据）。

## 当前状态

第一阶段：最小可用镜像，用于验证 Render 免费档能否从公开仓库构建自定义 Dockerfile。
