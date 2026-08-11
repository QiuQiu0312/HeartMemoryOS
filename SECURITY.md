# 安全政策

HeartMemoryOS 会处理聊天内容、长期记忆和模型密钥。请不要在公开 Issue、Discussion、Pull Request、截图或日志中披露真实 API Key、`.env`、聊天记录、用户身份、数据库或可直接利用的漏洞细节。

## 支持范围

项目当前处于 Alpha 阶段，只对最新提交和最新发布版本提供安全修复。生产使用者仍需对自己的身份系统、网络边界、数据库、密钥管理、通知渠道和合规负责。

## 私密报告漏洞

仓库公开后，维护者应在 GitHub 的 `Settings → Security → Advanced Security` 中开启 **Private vulnerability reporting**。开启后，请通过仓库 `Security → Advisories → Report a vulnerability` 私密提交。

如果该入口尚未开启，请只创建一条不含漏洞细节的普通 Issue，请维护者提供私密联系渠道。

报告中建议包含：受影响版本、复现条件、影响、最小复现步骤和建议缓解方式。不要测试或访问不属于你的用户数据。

## 密钥意外泄露

如果 API Key、服务器 Secret 或其他凭据曾进入 Git 提交，即使之后删除文件也不够。请立即到对应平台撤销或轮换密钥，然后再清理 Git 历史与缓存副本。
