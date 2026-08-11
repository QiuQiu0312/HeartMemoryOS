import type { Metadata } from "next";
import { CompanionChat } from "./CompanionChat";

export const metadata: Metadata = {
  title: "心忆 · 本地伴侣体验",
  description: "用于体验可迁移长期记忆架构的本地虚拟伴侣聊天页。",
};

export default function Home() {
  return <CompanionChat />;
}
