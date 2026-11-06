// 前端配置：只填环境 ID 和云函数地址，不要填任何密钥、密码。
// API_BASE_URL 为空时，前端自动使用本地模式（localStorage，按设备保存），
// 方便在没有云环境时预览界面；部署后填入云函数 HTTP 触发地址即切换为云端模式。
window.EBOOK_CONFIG = {
  ENV_ID: "your-env-id-here",
  API_BASE_URL: ""
};
