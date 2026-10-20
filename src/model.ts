/** Shared data types. JSON field names are snake_case on purpose: agents and
 * scripts consume this output and the Go-era field names are still in use. */

export type Origin = "file" | "env" | "command" | "default" | "unknown";

export interface Mirror {
  id: string;
  name: string;
  url: string;
  probe?: string;
  official?: boolean;
  region?: string;
  note?: string;
  trusted_host?: string;
  meta?: Record<string, string>;
  custom?: boolean;
}

export interface Status {
  source: string;
  raw: string;
  file: string;
  origin: Origin;
  note?: string;
  backup?: string;
}

export interface ToolView {
  id: string;
  name: string;
  category: string;
  installed: boolean;
  on_path: boolean;
  version?: string;
  binary?: string;
  config_file?: string;
  config_exists: boolean;
  current: Status;
  mirror_id?: string;
  mirrors: Mirror[];
  supports_write: boolean;
  error?: string;
}

export interface Change {
  tool: string;
  mirror: Mirror;
  before: Status;
  after: Status;
  file: string;
  backup?: string;
  dry_run: boolean;
  changed: boolean;
  note?: string;
}

export interface ProbeResult {
  tool_id: string;
  mirror_id: string;
  name: string;
  url: string;
  ok: boolean;
  status: number;
  ttfb_ms: number;
  total_ms: number;
  error?: string;
}

export interface Summary {
  tools: number;
  installed: number;
  configured: number;
}

export interface ListData {
  summary: Summary;
  tools: ToolView[];
}
