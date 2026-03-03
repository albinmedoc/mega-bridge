import { describe, it, expect } from 'vitest';
import {
  parseMegaFolderUrl,
  buildMegaFolderUrl,
  collectFiles,
  buildFileMap,
  getNodeId,
} from '../../src/helpers/mega';
import type mega from 'megajs';

// Helper to create mock mega.File-like objects
function mockFile(overrides: Partial<mega.File> = {}): mega.File {
  return {
    name: 'file.txt',
    size: 1024,
    directory: false,
    nodeId: 'node123',
    downloadId: ['x', 'dl123'],
    children: [],
    ...overrides,
  } as unknown as mega.File;
}

function mockDir(name: string, children: mega.File[]): mega.File {
  return {
    name,
    directory: true,
    children,
  } as unknown as mega.File;
}

describe('parseMegaFolderUrl', () => {
  it('parses a valid MEGA folder URL', () => {
    const result = parseMegaFolderUrl('https://mega.nz/folder/ABC123#key456');
    expect(result).toEqual({ folderId: 'ABC123', folderKey: 'key456' });
  });

  it('parses URL without https prefix', () => {
    const result = parseMegaFolderUrl('mega.nz/folder/ABC123#key456');
    expect(result).toEqual({ folderId: 'ABC123', folderKey: 'key456' });
  });

  it('returns null for invalid URL', () => {
    expect(parseMegaFolderUrl('https://google.com')).toBeNull();
    expect(parseMegaFolderUrl('')).toBeNull();
    expect(parseMegaFolderUrl('mega.nz/file/ABC#key')).toBeNull();
  });

  it('returns null for URL missing key', () => {
    expect(parseMegaFolderUrl('https://mega.nz/folder/ABC123')).toBeNull();
  });
});

describe('buildMegaFolderUrl', () => {
  it('builds a valid MEGA folder URL', () => {
    const url = buildMegaFolderUrl('ABC123', 'key456');
    expect(url).toBe('https://mega.nz/folder/ABC123#key456');
  });

  it('round-trips with parseMegaFolderUrl', () => {
    const url = buildMegaFolderUrl('fId', 'fKey');
    const parsed = parseMegaFolderUrl(url);
    expect(parsed).toEqual({ folderId: 'fId', folderKey: 'fKey' });
  });
});

describe('getNodeId', () => {
  it('returns nodeId when available', () => {
    const file = mockFile({ nodeId: 'abc' });
    expect(getNodeId(file)).toBe('abc');
  });

  it('falls back to downloadId[1]', () => {
    const file = mockFile({ nodeId: undefined, downloadId: ['x', 'fallback'] });
    expect(getNodeId(file)).toBe('fallback');
  });

  it('returns empty string when neither available', () => {
    const file = mockFile({ nodeId: undefined, downloadId: undefined });
    expect(getNodeId(file)).toBe('');
  });
});

describe('collectFiles', () => {
  it('collects files from a flat folder', () => {
    const root = mockDir('root', [
      mockFile({ name: 'a.txt' }),
      mockFile({ name: 'b.txt' }),
    ]);

    const files = collectFiles(root);
    expect(files).toHaveLength(2);
    expect(files[0].file.name).toBe('a.txt');
    expect(files[0].path).toBe('');
    expect(files[1].file.name).toBe('b.txt');
  });

  it('collects files from nested directories', () => {
    const root = mockDir('root', [
      mockDir('subdir', [
        mockFile({ name: 'deep.txt' }),
      ]),
      mockFile({ name: 'top.txt' }),
    ]);

    const files = collectFiles(root);
    expect(files).toHaveLength(2);

    const deep = files.find(f => f.file.name === 'deep.txt');
    expect(deep?.path).toBe('subdir');

    const top = files.find(f => f.file.name === 'top.txt');
    expect(top?.path).toBe('');
  });

  it('handles deeply nested directories', () => {
    const root = mockDir('root', [
      mockDir('a', [
        mockDir('b', [
          mockFile({ name: 'nested.txt' }),
        ]),
      ]),
    ]);

    const files = collectFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('a/b');
  });

  it('returns empty array for empty folder', () => {
    const root = mockDir('root', []);
    expect(collectFiles(root)).toEqual([]);
  });

  it('filters by glob patterns', () => {
    const root = mockDir('root', [
      mockFile({ name: 'readme.md' }),
      mockFile({ name: 'code.ts' }),
      mockDir('docs', [
        mockFile({ name: 'guide.md' }),
      ]),
    ]);

    const files = collectFiles(root, '', ['**/*.md']);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.file.name!.endsWith('.md'))).toBe(true);
  });

  it('excludes non-matching files with patterns', () => {
    const root = mockDir('root', [
      mockFile({ name: 'keep.txt' }),
      mockFile({ name: 'skip.log' }),
    ]);

    const files = collectFiles(root, '', ['*.txt']);
    expect(files).toHaveLength(1);
    expect(files[0].file.name).toBe('keep.txt');
  });

  it('ignores patterns when empty array', () => {
    const root = mockDir('root', [
      mockFile({ name: 'a.txt' }),
      mockFile({ name: 'b.log' }),
    ]);

    const files = collectFiles(root, '', []);
    expect(files).toHaveLength(2);
  });
});

describe('buildFileMap', () => {
  it('builds a map of nodeId to mega.File', () => {
    const root = mockDir('root', [
      mockFile({ name: 'a.txt', nodeId: 'n1' }),
      mockDir('sub', [
        mockFile({ name: 'b.txt', nodeId: 'n2' }),
      ]),
    ]);

    const map = buildFileMap(root);
    expect(map.size).toBe(2);
    expect(map.get('n1')?.name).toBe('a.txt');
    expect(map.get('n2')?.name).toBe('b.txt');
  });

  it('uses downloadId fallback for nodeId', () => {
    const root = mockDir('root', [
      mockFile({ name: 'a.txt', nodeId: undefined, downloadId: ['x', 'dl1'] }),
    ]);

    const map = buildFileMap(root);
    expect(map.get('dl1')?.name).toBe('a.txt');
  });

  it('returns empty map for empty folder', () => {
    const root = mockDir('root', []);
    expect(buildFileMap(root).size).toBe(0);
  });
});
