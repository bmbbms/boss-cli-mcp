# 发布到阿里云 npm 仓库

本项目可以发布到阿里云 Packages 的 npm 私有仓库。每个企业空间的 registry URL
不同，请从阿里云控制台的仓库“连接/使用说明”中复制完整地址，不要自行猜测 URL。

## 1. 准备 registry 地址

示例格式（仅示例，不能直接使用）：

```text
https://packages.aliyun.com/621cab5b756fe0dd8b6d7c29/npm/repo-apxsi/
```

建议保留末尾的 `/`，并在 PowerShell 中保存为当前会话变量：

```powershell
cd D:\boss-cli
$registry = "https://packages.aliyun.com/621cab5b756fe0dd8b6d7c29/npm/repo-apxsi/"
```

## 2. 登录

使用阿里云控制台创建的账号、访问凭证或 npm Token 登录：

```powershell
npm login --registry=$registry
```

登录信息由 npm 保存到用户配置目录，不会写入项目。可以检查当前登录状态：

```powershell
npm whoami --registry=$registry
```

如果企业仓库要求 Token，推荐使用：

```powershell
npm config set //packages.aliyun.com/npm/npm-registry/<仓库ID>/:_authToken=<TOKEN> --location=user
```

不要把包含 `_authToken` 的 `.npmrc` 提交到 Git。

## 3. 构建并发布

```powershell
npm run build
npm publish --registry=$registry
```

项目的 `publishConfig.registry` 已设置为当前阿里云仓库，因此也可以直接执行
`npm publish`；显式传入 `--registry` 仍然更直观。

如果仍然返回 `403 Forbidden`，请让阿里云仓库管理员确认当前账号具有“发布/写入”
权限，并确认仓库已允许发布无 scope 包 `boss-cli-mcp`。

`prepack` 和 `prepublishOnly` 会再次执行构建；包中会包含 `dist`、README、MCP
文档和运行所需的 `skills`，不会包含 `src`、`node_modules`、`.env` 或本地登录态。

发布前可先查看实际打包内容：

```powershell
npm pack --dry-run
```

## 4. 验证和安装

```powershell
npm view boss-cli-mcp version --registry=$registry
npm install -g boss-cli-mcp --registry=$registry
boss-cli-mcp
```

MCP 客户端使用全局命令时：

```json
{
  "boss-recruiter": {
    "type": "stdio",
    "command": "boss-cli-mcp",
    "args": []
  }
}
```

如果客户端没有继承系统 PATH，可以执行 `npm root -g`，改用该目录下
`boss-cli-mcp/dist/mcp/index.js` 的绝对路径，并指定 Node.js 20 或更高版本。

## 常见错误

- `ENEEDAUTH`：当前 npm 用户未登录该 registry，重新执行 `npm login --registry=...`。
- `403 Forbidden`：账号没有发布权限，或仓库要求 scoped 包名；联系阿里云仓库管理员确认。
- `cannot publish over previously published version`：版本号已存在，执行
  `npm version patch --no-git-tag-version` 后重新发布。
- `404 Not Found`：registry URL 不完整、仓库 ID 错误，或当前账号无权访问。
