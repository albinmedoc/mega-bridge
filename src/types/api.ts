export interface FolderSummary {
  folderId: string;
  name: string;
  loadedAt: string;
  downloading: boolean;
  rateLimited: boolean;
  rateLimitedAt: string | null;
  files: {
    total: number;
    completed: number;
    downloading: number;
    pending: number;
    failed: number;
  };
}

export interface FolderDetail extends FolderSummary {
  files: FolderSummary['files'] & {
    items: FileDetail[];
  };
}

export interface FileDetail {
  nodeId: string;
  name: string;
  size: number;
  timestamp: number | null;
  status: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
