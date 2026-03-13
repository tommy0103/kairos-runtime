# UserBot 部署指南

## 概述

项目已支持 UserBot 模式，可以通过用户账号（而非 Bot Token）运行，具有以下优势：
- 接收所有消息（无需 @提及）
- 支持消息编辑和删除
- 可以读取历史消息

## 部署步骤

### 1. 服务器环境准备

```bash
# 安装 Docker 和 Docker Compose
# Ubuntu/Debian
sudo apt update
sudo apt install -y docker.io docker-compose

# 或者使用官方脚本
curl -fsSL https://get.docker.com | sh
```

### 2. 克隆项目

```bash
git clone <your-repo-url>
cd memoh-lite

# 初始化子模块（VFS）
git submodule update --init --recursive
```

### 3. 配置 UserBot

#### 获取 Telegram API 凭证

1. 访问 https://my.telegram.org/apps
2. 登录并创建新应用
3. 记录 `api_id` 和 `api_hash`

#### 配置环境变量

```bash
# 创建环境变量文件
cat > .env << 'EOF'
# UserBot 模式配置
TELEGRAM_MODE=userbot
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_PHONE=+86138xxxxxxxx
TELEGRAM_PASSWORD=your_2fa_password  # 如果有两步验证

# 其他配置
OWNER_USER_ID=your_telegram_user_id
BOT_TOKEN=  # UserBot 模式下不需要，但保留空值

# 模型配置
API_KEY=your_llm_api_key
OLLAMA_BASE_URL=http://host.docker.internal:11434
EOF
```

### 4. 首次运行（获取 Session）

```bash
# 构建并运行
docker-compose up --build app

# 首次运行会提示输入验证码
# 登录成功后，session 会自动保存
# 按 Ctrl+C 停止
```

### 5. 后台运行

```bash
# 后台运行
docker-compose up -d app

# 查看日志
docker-compose logs -f app
```

## 配置说明

### 配置文件结构

```
.runtime/appconfig/
├── base.json              # 基础配置
└── profiles/
    ├── local.json         # 本地开发
    └── production.json    # 生产环境（可创建）
```

### UserBot 配置示例

```json
{
  "stateDaemon": {
    "telegram": {
      "mode": "userbot",
      "userbot": {
        "apiId": "${ENV:TELEGRAM_API_ID}",
        "apiHash": "${ENV:TELEGRAM_API_HASH}",
        "phoneNumber": "${ENV:TELEGRAM_PHONE}",
        "password": "${ENV:TELEGRAM_PASSWORD:-}"
      },
      "ownerUserId": "${ENV:OWNER_USER_ID}"
    }
  }
}
```

## 切换回 Bot 模式

```bash
# 修改环境变量
export TELEGRAM_MODE=bot
export BOT_TOKEN=your_bot_token

# 重启服务
docker-compose restart app
```

## 常见问题

### 1. Session 过期

如果 session 过期，删除 session 文件并重新登录：

```bash
# 删除 session 文件
rm -f .runtime/userbot.session

# 重新运行获取新 session
docker-compose up app
```

### 2. 容器内无法访问外部服务

检查 `extra_hosts` 配置：

```yaml
# docker-compose.yml
services:
  app:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### 3. 权限问题

如果遇到 containerd.sock 权限问题：

```bash
# 添加用户到 docker 组
sudo usermod -aG docker $USER

# 重新登录或执行
newgrp docker
```

## 安全建议

1. **保护 API 凭证**: 不要将 `.env` 文件提交到 Git
2. **使用 2FA**: 为 Telegram 账号开启两步验证
3. **限制访问**: 使用防火墙限制服务器访问
4. **定期备份**: 备份 `.runtime` 目录中的 session 文件

## 监控和日志

```bash
# 实时查看日志
docker-compose logs -f --tail=100 app

# 查看资源使用
docker stats

# 重启服务
docker-compose restart app
```
