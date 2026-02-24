import type mega from 'megajs';

export interface DownloadTask {
  folderId: string;
  nodeId: string;
  megaFile: mega.File;
  name: string;
  size: number;
}
