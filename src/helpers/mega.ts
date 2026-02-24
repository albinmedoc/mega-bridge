import mega from 'megajs';
import { Logger } from './logger';

const log = new Logger('mega');

/**
 * Parse a MEGA folder URL into its folder ID and key.
 * Format: https://mega.nz/folder/FOLDER_ID#FOLDER_KEY
 */
export function parseMegaFolderUrl(url: string): { folderId: string; folderKey: string } | null {
  const match = url.match(/mega\.nz\/folder\/([^#]+)#(.+)/);
  if (!match) return null;
  return { folderId: match[1], folderKey: match[2] };
}

/**
 * Reconstruct a MEGA folder URL from its parts.
 */
export function buildMegaFolderUrl(folderId: string, folderKey: string): string {
  return `https://mega.nz/folder/${folderId}#${folderKey}`;
}

/**
 * Load a MEGA folder and return its root File object.
 */
export async function loadMegaFolder(url: string): Promise<mega.File> {
  log.info('Loading MEGA folder', { url: url.replace(/#.*/, '#***') });

  const folder = mega.File.fromURL(url);
  await folder.loadAttributes();
  return folder as mega.File;
}

/**
 * Recursively collect all non-directory files from a MEGA folder tree.
 */
export function collectFiles(node: mega.File): mega.File[] {
  const result: mega.File[] = [];
  for (const child of node.children || []) {
    if (child.directory) {
      result.push(...collectFiles(child));
    } else {
      result.push(child);
    }
  }
  return result;
}

/**
 * Build a map of nodeId → mega.File for all files in a folder.
 */
export function buildFileMap(root: mega.File): Map<string, mega.File> {
  const map = new Map<string, mega.File>();

  function walk(node: mega.File): void {
    for (const child of node.children || []) {
      if (child.directory) {
        walk(child);
      } else {
        const nodeId = child.nodeId || child.downloadId?.[1] || '';
        map.set(nodeId, child);
      }
    }
  }

  walk(root);
  return map;
}

/**
 * Extract a stable node ID from a mega.File object.
 */
export function getNodeId(file: mega.File): string {
  return file.nodeId || file.downloadId?.[1] || '';
}
