import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 项目说明统一放在 README 和 docs/plans 里，不需要 Next 再生成一份。
  agentRules: false,
};

export default nextConfig;
