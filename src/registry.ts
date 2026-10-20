/** Static tool metadata: how to find the binary, how to ask for its version. */

export type Category = "javascript" | "python" | "golang" | "rust" | "php" | "ruby" | "dotnet";

export interface ToolMeta {
  id: string;
  name: string;
  category: Category;
  binaries: string[];
  versionArgs: string[];
}

export const TOOLS: ToolMeta[] = [
  { id: "npm", name: "npm", category: "javascript", binaries: ["npm"], versionArgs: ["--version"] },
  { id: "pnpm", name: "pnpm", category: "javascript", binaries: ["pnpm"], versionArgs: ["--version"] },
  { id: "yarn", name: "yarn", category: "javascript", binaries: ["yarn"], versionArgs: ["--version"] },
  { id: "bun", name: "bun", category: "javascript", binaries: ["bun"], versionArgs: ["--version"] },
  { id: "pip", name: "pip", category: "python", binaries: ["pip", "pip3"], versionArgs: ["--version"] },
  { id: "uv", name: "uv", category: "python", binaries: ["uv"], versionArgs: ["--version"] },
  { id: "go", name: "go", category: "golang", binaries: ["go"], versionArgs: ["version"] },
  { id: "cargo", name: "cargo", category: "rust", binaries: ["cargo"], versionArgs: ["--version"] },
  { id: "composer", name: "composer", category: "php", binaries: ["composer", "composer.phar"], versionArgs: ["--version"] },
  { id: "gem", name: "gem", category: "ruby", binaries: ["gem", "bundle"], versionArgs: ["--version"] },
  { id: "nuget", name: "nuget", category: "dotnet", binaries: ["dotnet", "nuget"], versionArgs: ["--version"] },
];

export function find(id: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function ids(): string[] {
  return TOOLS.map((t) => t.id);
}
