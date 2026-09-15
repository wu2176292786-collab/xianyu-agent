import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 项目说明统一放在 README 和 docs/plans 里，不需要 Next 再生成一份。
  agentRules: false,

  // 用 127.0.0.1 或局域网 IP 打开开发服务器时，Next 默认会拦掉 HMR 连接，
  // 页面会停在「渲染出来了但点不动」的状态。把这些来源放行。
  allowedDevOrigins: ["127.0.0.1", "0.0.0.0", "*.local"],

  // 窄屏下这个浮标会跑到左上角，正好压住汉堡菜单按钮，菜单就点不开了。
  devIndicators: false,
};

export default nextConfig;
