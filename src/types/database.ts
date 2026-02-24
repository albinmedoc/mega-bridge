export type FileStatus = 'pending' | 'downloading' | 'completed' | 'failed';

export interface FolderRow {
  folder_id: string;
  folder_key: string;
  name: string;
  loaded_at: string;
  downloading: number;
  rate_limited: number;
  rate_limited_at: string | null;
}

export interface FileRow {
  node_id: string;
  folder_id: string;
  name: string;
  size: number;
  timestamp: number | null;
  status: FileStatus;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface FileStatsRow {
  folder_id: string;
  total: number;
  completed: number;
  downloading: number;
  pending: number;
  failed: number;
}
