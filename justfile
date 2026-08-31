# shushu 本地开发目标
default:
    @just --list

# 本地全局安装（构建 + 把当前目录挂到全局，之后直接 `shushu`）
install:
    npm run build
    npm install -g .

# 直接运行一个子命令（免全局安装）
# 例如：just run search 深度学习 --type video
run *args:
    npm run build
    node dist/cli.js {{args}}

# 仅构建
build:
    npm run build

# 类型检查
check:
    npx tsc --noEmit
