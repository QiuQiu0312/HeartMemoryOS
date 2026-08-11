# 参与贡献

感谢你愿意帮助完善 HeartMemoryOS。当前项目处于 Alpha 阶段，优先接受可复现缺陷、安全修复、文档澄清、测试补强和不破坏核心协议的适配器。

## 提交问题前

1. 先搜索已有 Issue，避免重复。
2. 不要在 Issue、截图或日志中提交 API Key、`.env`、聊天记录、真实用户身份或数据库。
3. 安全漏洞请按 `SECURITY.md` 私密报告，不要公开披露利用细节。
4. 功能建议请说明真实使用场景、预期行为和 Token/隐私影响。

## 本地开发

需要 Node.js 22.13 或更高版本：

```bash
npm run setup
npm run doctor
npm test
```

启动本地体验：

```bash
npm run launch
```

核心后端没有第三方运行时依赖；控制台依赖由 `apps/console/package-lock.json` 锁定。

## 变更原则

- 不让模型决定身份、权限、授权、删除、处理游标或是否发送消息。
- 不让摘要替代权威 Claim、Evidence、Revision 与 Correction。
- 不绕过 Realm、Attribution、Consent、Tombstone 和 Suppression。
- 新增模型调用时必须说明触发条件、预算、失败降级、用量记录和用户开关。
- 修改 API、Prompt 或 Schema 时必须考虑版本兼容和迁移。
- 不提交 `.env`、`data/`、数据库、构建产物或本地依赖目录。

## Pull Request

请保持一次 PR 只解决一个清晰问题，并写明：

- 为什么要改；
- 改了哪些行为；
- 怎样验证；
- 是否增加模型调用或数据保留；
- 是否改变公开 API、数据库或 Prompt；
- 对旧版本的兼容方式。

提交前运行 `npm test`。如果某项因为环境无法执行，请在 PR 中如实说明，不要把“没运行”写成“已通过”。
