import type { Metadata } from "next";
import { MemoryConsole } from "../MemoryConsole";

export const metadata: Metadata = {
  title: "记忆后台",
  description: "查看、解释、纠正和删除本地陪伴记忆。",
};

export default function ConsolePage() {
  return <MemoryConsole />;
}
