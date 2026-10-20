/** Built-in mirror catalog. Data only: the adapters decide how a mirror is
 * written into each tool's configuration file. */

import type { Mirror } from "./model.js";

export const officialNpm = "https://registry.npmjs.org";
export const officialPyPI = "https://pypi.org/simple";
export const officialGo = "https://proxy.golang.org,direct";
export const officialCargo = "sparse+https://index.crates.io/";
export const officialPacker = "https://repo.packagist.org";
export const officialGem = "https://rubygems.org";
export const officialNuGet = "https://api.nuget.org/v3/index.json";

const npmMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "https://registry.npmjs.org", probe: "https://registry.npmjs.org/-/ping", official: true, region: "global" },
  { id: "npmmirror", name: "npmmirror", url: "https://registry.npmmirror.com", probe: "https://registry.npmmirror.com/-/ping", region: "cn", note: "淘宝源，国内使用最广" },
  { id: "tencent", name: "腾讯云", url: "https://mirrors.cloud.tencent.com/npm/", probe: "https://mirrors.cloud.tencent.com/npm/-/ping", region: "cn" },
  { id: "huawei", name: "华为云", url: "https://repo.huaweicloud.com/repository/npm/", probe: "https://repo.huaweicloud.com/repository/npm/", region: "cn" },
  { id: "yarnpkg", name: "Yarn 官方", url: "https://registry.yarnpkg.com", probe: "https://registry.yarnpkg.com/-/ping", region: "global" },
];

const pipMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "https://pypi.org/simple", probe: "https://pypi.org/simple/pip/", official: true, region: "global" },
  { id: "tuna", name: "清华 TUNA", url: "https://pypi.tuna.tsinghua.edu.cn/simple", probe: "https://pypi.tuna.tsinghua.edu.cn/simple/pip/", region: "cn", trusted_host: "pypi.tuna.tsinghua.edu.cn" },
  { id: "aliyun", name: "阿里云", url: "https://mirrors.aliyun.com/pypi/simple/", probe: "https://mirrors.aliyun.com/pypi/simple/pip/", region: "cn", trusted_host: "mirrors.aliyun.com" },
  { id: "ustc", name: "中科大", url: "https://mirrors.ustc.edu.cn/pypi/simple", probe: "https://mirrors.ustc.edu.cn/pypi/simple/pip/", region: "cn", trusted_host: "mirrors.ustc.edu.cn" },
  { id: "tencent", name: "腾讯云", url: "https://mirrors.cloud.tencent.com/pypi/simple", probe: "https://mirrors.cloud.tencent.com/pypi/simple/pip/", region: "cn", trusted_host: "mirrors.cloud.tencent.com" },
  { id: "huawei", name: "华为云", url: "https://repo.huaweicloud.com/repository/pypi/simple", probe: "https://repo.huaweicloud.com/repository/pypi/simple/pip/", region: "cn", trusted_host: "repo.huaweicloud.com" },
];

const goMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "https://proxy.golang.org,direct", probe: "https://proxy.golang.org/github.com/google/uuid/@v/list", official: true, region: "global" },
  { id: "goproxy-cn", name: "goproxy.cn", url: "https://goproxy.cn,direct", probe: "https://goproxy.cn/github.com/google/uuid/@v/list", region: "cn", note: "七牛云维护" },
  { id: "goproxy-io", name: "goproxy.io", url: "https://goproxy.io,direct", probe: "https://goproxy.io/github.com/google/uuid/@v/list", region: "cn" },
  { id: "aliyun", name: "阿里云", url: "https://mirrors.aliyun.com/goproxy/,direct", probe: "https://mirrors.aliyun.com/goproxy/github.com/google/uuid/@v/list", region: "cn" },
];

const cargoMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "sparse+https://index.crates.io/", probe: "https://index.crates.io/config.json", official: true, region: "global" },
  { id: "rsproxy", name: "RsProxy", url: "sparse+https://rsproxy.cn/index/", probe: "https://rsproxy.cn/index/config.json", region: "cn", note: "字节跳动维护" },
  { id: "tuna", name: "清华 TUNA", url: "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/", probe: "https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/config.json", region: "cn" },
  { id: "ustc", name: "中科大", url: "sparse+https://mirrors.ustc.edu.cn/crates.io-index/", probe: "https://mirrors.ustc.edu.cn/crates.io-index/config.json", region: "cn" },
];

const composerMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "https://repo.packagist.org", probe: "https://repo.packagist.org/packages.json", official: true, region: "global" },
  { id: "aliyun", name: "阿里云", url: "https://mirrors.aliyun.com/composer/", probe: "https://mirrors.aliyun.com/composer/packages.json", region: "cn" },
  { id: "tencent", name: "腾讯云", url: "https://mirrors.cloud.tencent.com/composer/", probe: "https://mirrors.cloud.tencent.com/composer/packages.json", region: "cn" },
  { id: "huawei", name: "华为云", url: "https://repo.huaweicloud.com/repository/php/", probe: "https://repo.huaweicloud.com/repository/php/packages.json", region: "cn" },
];

const gemMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "https://rubygems.org", probe: "https://rubygems.org/specs.4.8.gz", official: true, region: "global" },
  { id: "tuna", name: "清华 TUNA", url: "https://mirrors.tuna.tsinghua.edu.cn/rubygems/", probe: "https://mirrors.tuna.tsinghua.edu.cn/rubygems/specs.4.8.gz", region: "cn" },
  { id: "ustc", name: "中科大", url: "https://mirrors.ustc.edu.cn/rubygems/", probe: "https://mirrors.ustc.edu.cn/rubygems/specs.4.8.gz", region: "cn" },
  { id: "aliyun", name: "阿里云", url: "https://mirrors.aliyun.com/rubygems/", probe: "https://mirrors.aliyun.com/rubygems/specs.4.8.gz", region: "cn" },
];

const nugetMirrors: Mirror[] = [
  { id: "official", name: "官方源", url: "https://api.nuget.org/v3/index.json", probe: "https://api.nuget.org/v3/index.json", official: true, region: "global" },
  { id: "huawei", name: "华为云", url: "https://repo.huaweicloud.com/repository/nuget/v3/index.json", probe: "https://repo.huaweicloud.com/repository/nuget/v3/index.json", region: "cn" },
];

const byTool: Record<string, Mirror[]> = {
  npm: npmMirrors,
  pnpm: npmMirrors,
  yarn: npmMirrors,
  bun: npmMirrors,
  pip: pipMirrors,
  uv: pipMirrors,
  go: goMirrors,
  cargo: cargoMirrors,
  composer: composerMirrors,
  gem: gemMirrors,
  nuget: nugetMirrors,
};

export function mirrors(tool: string): Mirror[] {
  return (byTool[tool] ?? []).map((m) => ({ ...m }));
}

export function official(tool: string): Mirror {
  return mirrors(tool).find((m) => m.official) ?? { id: "official", name: "官方源", url: "", official: true };
}

export function tools(): string[] {
  return ["npm", "pnpm", "yarn", "bun", "pip", "uv", "go", "cargo", "composer", "gem", "nuget"];
}
