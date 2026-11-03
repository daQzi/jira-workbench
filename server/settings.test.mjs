import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_JIRA_BASE_URL, DEFAULT_LLM, isLocalRequest, jiraOrDefault, maskKey, normalizeUrl, parseSettingsInput, saveSettings } from './settings.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('连接设置', () => {
  it('地址规范化与校验', () => {
    expect(normalizeUrl(' https://jira.example.com/ ', 'x')).toBe('https://jira.example.com');
    expect(normalizeUrl('https://llm.example.com/v1/', 'x')).toBe('https://llm.example.com/v1');
    expect(() => normalizeUrl('ftp://a', 'x')).toThrow('只支持');
    expect(() => normalizeUrl('jira.example.com', 'x')).toThrow('格式不正确');
    expect(() => normalizeUrl('https://u:p@a.com', 'x')).toThrow('账号密码');
    expect(() => normalizeUrl('', 'Jira 地址')).toThrow('请填写Jira 地址');
  });

  it('发行默认配置为空，保留用户配置', () => {
    expect(DEFAULT_JIRA_BASE_URL).toBe('');
    expect(DEFAULT_LLM).toEqual({ baseUrl: '', model: '' });
    expect(jiraOrDefault(undefined)).toBe('');
    expect(jiraOrDefault('')).toBe(DEFAULT_JIRA_BASE_URL);
    expect(jiraOrDefault('https://other.jira')).toBe('https://other.jira');
  });

  it('允许仅配置 Jira，但大模型配置一旦填写必须完整且合法', () => {
    const input = { jiraBaseUrl: 'https://jira.example.com', llmBaseUrl: '', llmModel: '' };
    expect(parseSettingsInput(input).llm).toEqual({ baseUrl: '', model: '' });
    expect(() => parseSettingsInput({ ...input, llmBaseUrl: 'https://llm.example.com/v1' })).toThrow('模型 ID');
    expect(() => parseSettingsInput({ ...input, llmModel: 'model' })).toThrow('大模型请求地址');
    expect(() => parseSettingsInput({ ...input, llmBaseUrl: 'ftp://bad', llmModel: 'model' })).toThrow('只支持');
    expect(() => parseSettingsInput({ ...input, jiraBaseUrl: '' })).toThrow('Jira 地址');
  });

  it('Key 留空表示沿用；只露末 4 位', () => {
    const base = { jiraBaseUrl: 'https://a.com', llmBaseUrl: 'https://b.com/v1', llmModel: 'm1' };
    expect(parseSettingsInput({ ...base, llmApiKey: '' }).llm).toEqual({ baseUrl: 'https://b.com/v1', model: 'm1' });
    expect(parseSettingsInput({ ...base, llmApiKey: ' sk-1 ' }).llm.apiKey).toBe('sk-1');
    expect(() => parseSettingsInput({ ...base, llmModel: 'a b' })).toThrow('模型 ID');
    expect(maskKey('sk-cpa-1234567890abcd')).toBe('sk-****abcd');
    expect(maskKey('')).toBe('');
  });

  it('合并写回，保留其他配置，权限 0600', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'wb-set-'));
    dirs.push(d);
    const f = path.join(d, 'config.json');
    writeFileSync(f, JSON.stringify({ allowWrite: true, llm: { apiKey: 'old', timeoutMs: 1 } }));
    saveSettings(f, { jiraBaseUrl: 'https://a.com', llm: { baseUrl: 'https://b', model: 'm' } });
    const c = JSON.parse(readFileSync(f, 'utf8'));
    expect(c).toEqual({ allowWrite: true, jiraBaseUrl: 'https://a.com', llm: { apiKey: 'old', timeoutMs: 1, baseUrl: 'https://b', model: 'm' } });
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('只接受本机同源请求', () => {
    expect(isLocalRequest({ host: '127.0.0.1:18787' })).toBe(true);
    expect(isLocalRequest({ host: '127.0.0.1:18787', origin: 'http://127.0.0.1:18787' })).toBe(true);
    expect(isLocalRequest({ host: '127.0.0.1:18787', origin: 'https://evil.com' })).toBe(false);
    expect(isLocalRequest({ host: 'evil.com:18787' })).toBe(false);
  });
});
