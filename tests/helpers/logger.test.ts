import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LogLevel } from '../../src/helpers/logger';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs info messages to stdout', () => {
    const logger = new Logger('test', LogLevel.DEBUG);
    logger.info('hello');

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('INFO');
    expect(output.context).toBe('test');
    expect(output.message).toBe('hello');
    expect(output.timestamp).toBeDefined();
  });

  it('logs error messages to stderr', () => {
    const logger = new Logger('test', LogLevel.DEBUG);
    logger.error('fail');

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('ERROR');
    expect(output.message).toBe('fail');
  });

  it('includes meta when provided', () => {
    const logger = new Logger('test', LogLevel.DEBUG);
    logger.info('with meta', { key: 'value' });

    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.meta).toEqual({ key: 'value' });
  });

  it('omits meta when not provided', () => {
    const logger = new Logger('test', LogLevel.DEBUG);
    logger.info('no meta');

    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.meta).toBeUndefined();
  });

  it('filters messages below minimum level', () => {
    const logger = new Logger('test', LogLevel.WARN);
    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('visible');

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('WARN');
  });

  it('creates child loggers with concatenated context', () => {
    const parent = new Logger('parent', LogLevel.DEBUG);
    const child = parent.child('child');
    child.info('from child');

    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.context).toBe('parent:child');
  });

  it('child inherits parent log level', () => {
    const parent = new Logger('parent', LogLevel.ERROR);
    const child = parent.child('child');
    child.info('hidden');
    child.error('visible');

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('logs at all four levels', () => {
    const logger = new Logger('test', LogLevel.DEBUG);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    // debug, info, warn → stdout; error → stderr
    expect(stdoutSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});
