import { bold, cyan, dim } from "./term.js";
import { version } from "../version.js";

export const commandNames = ["ls", "mirrors", "test", "use", "reset", "fastest", "add", "rm", "gui", "version", "help"] as const;

const usage = `${bold("mirrorhub")} ${dim(version)} — 包管理器镜像源切换器

${bold("用法")}
  mirrorhub <命令> [参数] [选项]

${bold("命令")}
  ls [--installed]                     列出工具及其当前镜像源
  mirrors [工具]                        列出内置与自定义镜像
  test [工具] [--refresh]               并发测试镜像可用性与延迟
  use <工具> <镜像>                     切换镜像源（镜像 id 或完整 URL）
  reset <工具>                          还原为官方源
  fastest <工具> [--apply]              自动选出最快的镜像
  add <工具> --name <名称> --url <地址>  添加自定义镜像
  rm <工具> <镜像 id>                   删除自定义镜像
  gui [--port N] [--no-open]            启动本地图形界面
  version                              显示版本
  help [命令]                           显示帮助

${bold("选项")}
  -j, --json        输出 JSON（agent 与脚本友好）
  -n, --dry-run     只显示将要做的修改，不写文件
      --no-color    禁用颜色
  -v, --verbose     在 ls 中额外显示配置文件路径
  -h, --help        显示帮助

${bold("示例")}
  mirrorhub ls
  mirrorhub ls -j
  mirrorhub test npm
  mirrorhub use npm npmmirror
  mirrorhub use pip tuna --dry-run
  mirrorhub fastest pip --apply
  mirrorhub add npm --name 公司源 --url https://registry.example.com/
  mirrorhub gui

${bold("说明")}
  测速会遵循 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量。
  修改配置前会自动备份为 <配置文件>.mirrorhub.bak。
  退出码：0 成功、1 运行失败、2 用法错误。`;

const details: Record<string, string> = {
  ls: `${bold("mirrorhub ls")} [--installed]

  列出所有受支持的工具：是否安装、版本、当前镜像与来源。
  --installed 只显示已安装的工具。
  示例：mirrorhub ls -j`,
  mirrors: `${bold("mirrorhub mirrors")} [工具]

  列出每个工具可用的镜像（内置 + 你添加的）。
  不给工具名时列出全部。
  示例：mirrorhub mirrors npm`,
  test: `${bold("mirrorhub test")} [工具] [--refresh]

  3 路并发探测镜像，输出是否可用与首字节延迟；
  相同的源测一次就同步到共用它的其它工具。
  不给工具名时测试全部工具；--refresh 忽略 5 分钟缓存。
  示例：mirrorhub test npm --refresh`,
  use: `${bold("mirrorhub use")} <工具> <镜像> [--dry-run]

  切换镜像源。镜像可以是 id（npmmirror）、名称或完整 URL。
  示例：mirrorhub use npm npmmirror`,
  reset: `${bold("mirrorhub reset")} <工具> [--dry-run]

  删除自己写入的镜像配置，回到官方源（不会动你的 token 等其它配置）。
  示例：mirrorhub reset npm`,
  fastest: `${bold("mirrorhub fastest")} <工具> [--apply] [--refresh]

  测速后按首字节延迟选出最快的可用镜像；--apply 直接切换。
  示例：mirrorhub fastest pip --apply`,
  add: `${bold("mirrorhub add")} <工具> --name <名称> --url <地址> [--note <备注>]

  添加自定义镜像，保存在用户配置里（升级不会丢）。
  示例：mirrorhub add npm --name 公司源 --url https://registry.example.com/`,
  rm: `${bold("mirrorhub rm")} <工具> <镜像 id>

  删除自定义镜像。内置镜像不能删除。
  示例：mirrorhub rm npm company`,
  gui: `${bold("mirrorhub gui")} [--port N] [--no-open]

  启动只监听 127.0.0.1 的本地图形界面，并在浏览器打开。
  同一时间只保留一个实例；关掉页面后按 Ctrl+C 退出。`,
};

export function helpText(command?: string): string {
  if (command && details[command]) return details[command];
  return usage;
}

export function versionText(): string {
  return `${cyan("mirrorhub")} ${version}`;
}
