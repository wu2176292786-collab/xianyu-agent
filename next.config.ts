import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * 本机所有的 IPv4 地址。
 *
 * 用 localhost 之外的地址打开开发服务器时（局域网调试、或者 VPN / 代理软件
 * 建的虚拟网卡），Next 会把 HMR 连接当成跨源请求拦掉，页面就停在
 * 「渲染出来了但点不动」的状态 —— 这个坑我们已经踩过两次了。
 *
 * 与其写死几个地址去猜，不如在启动时问一下系统：只放行本机自己的地址，
 * 不用给整个私网段开口子。
 */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === "IPv4")
    .map((entry) => entry!.address);
}

const nextConfig: NextConfig = {
  // 项目说明统一放在 README 和 docs/plans 里，不需要 Next 再生成一份。
  agentRules: false,

  allowedDevOrigins: ["localhost", "127.0.0.1", "0.0.0.0", "*.local", ...localAddresses()],

  // 窄屏下这个浮标会跑到左上角，正好压住汉堡菜单按钮，菜单就点不开了。
  devIndicators: false,
};

export default nextConfig;
