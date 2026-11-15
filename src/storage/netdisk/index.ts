/**
 * 国内个人网盘原生驱动集合。
 *
 * 与上一版「OpenList 网桥」的区别：不再需要额外部署 OpenList 实例，
 * 四个驱动各自实现登录态维护、路径解析、分片上传与代理下载。
 *
 * 四家的能力对照：
 *
 * | 能力            | 天翼 189        | 移动 139          | 联通 WoPan      | 阿里云盘        |
 * |-----------------|-----------------|-------------------|-----------------|-----------------|
 * | 官方 API        | 无（Web 私有）  | 无（Web 私有）    | 无（App 私有）  | 有（开放平台）  |
 * | 上传前整文件哈希| 否（lazyCheck） | 是（SHA-256）     | 否              | 否              |
 * | 分片            | 10 MB           | 100 MB            | 8 MB            | 10 MB           |
 * | token 续期      | 重新登录/换Cookie| refreshToken+userDomainId | refreshToken | refreshToken |
 * | 依赖 R2 暂存    | 否              | **是**            | 否              | 否              |
 *
 * 所有类型都是「恒中转」（RELAY_ONLY_POLICY_TYPES）：浏览器把整个文件作为
 * index=0 PUT 给 Worker，驱动内部再切片上云。好处是单文件大小只受 Workers
 * 请求体限制（免费档 100 MiB），坏处是流量过一次 Worker。
 */
import type { Env } from '../../env';
import type { StoragePolicyRow } from '../../db/types';
import { PolicyType } from '../../lib/boolset';
import type { StorageDriver } from '../types';
import { Cloud189Driver } from './cloud189';
import { Yun139Driver } from './yun139';
import { WoPanDriver } from './wopan';
import { AliyundriveDriver } from './aliyundrive';

export { Cloud189Driver } from './cloud189';
export { Yun139Driver } from './yun139';
export { WoPanDriver } from './wopan';
export { AliyundriveDriver } from './aliyundrive';

/** 四个网盘类型（不含阿里云盘之外的 S3 兼容类型）。 */
export const NETDISK_POLICY_TYPES: readonly string[] = [
  PolicyType.Cloud189,
  PolicyType.Yun139,
  PolicyType.WoPan,
  PolicyType.Aliyundrive,
];

export interface NetdiskPreset {
  label: string;
  /** 前端向导里展示的一句话说明 */
  hint: string;
  /** 需要管理员准备的凭据（按顺序展示） */
  requires: string[];
  /** 是否必须绑定 R2（上传前需要整文件哈希） */
  requiresR2: boolean;
}

export const NETDISK_PRESETS: Record<string, NetdiskPreset> = {
  cloud189: {
    label: '天翼云盘',
    hint: '填浏览器 Cookie 最稳（账号密码登录可能触发滑块验证）',
    requires: ['Cookie（推荐）或 账号 + 密码'],
    requiresR2: false,
  },
  yun139: {
    label: '移动云盘',
    hint: '需要 authorization；上传会先用 R2 暂存一次以计算 SHA-256',
    requires: ['authorization', '（可选）userDomainId'],
    requiresR2: true,
  },
  wopan: {
    label: '联通云盘',
    hint: '需要 access_token + refresh_token（从沃盘 App / 网页登录后抓取）',
    requires: ['access_token', 'refresh_token'],
    requiresR2: false,
  },
  aliyundrive: {
    label: '阿里云盘',
    hint: '官方开放平台接口，填 refresh_token 即可（2 小时自动续期）',
    requires: ['refresh_token', '（可选）client_id / client_secret'],
    requiresR2: false,
  },
};

/** 按策略类型构造驱动；未知类型抛错，由调用方的 switch 兜底。 */
export function createNetdiskDriver(env: Env, policy: StoragePolicyRow): StorageDriver {
  switch (policy.type) {
    case PolicyType.Cloud189:
      return new Cloud189Driver(policy);
    case PolicyType.Yun139:
      return new Yun139Driver(env, policy);
    case PolicyType.WoPan:
      return new WoPanDriver(policy);
    case PolicyType.Aliyundrive:
      return new AliyundriveDriver(policy);
    default:
      throw new Error(`不是国内网盘类型：${policy.type}`);
  }
}

/** 策略被修改后清掉 isolate 级缓存（token / 目录映射）。 */
export function invalidateNetdiskCaches(policyId: number): void {
  Cloud189Driver.invalidate(policyId);
  Yun139Driver.invalidate(policyId);
  WoPanDriver.invalidate(policyId);
  AliyundriveDriver.invalidate(policyId);
}

/** 后台新建策略前的连通性测试用的「未落库策略」形状。 */
export interface NetdiskProbeInput {
  type: string;
  name?: string;
  access_key?: string;
  secret_key?: string;
  bucket_name?: string;
  settings?: Record<string, unknown>;
}

/**
 * 用未落库的凭据做一次只读探测（登录 / 读根目录）。
 * 失败抛错，错误文案直接回给管理员。
 */
export async function probeNetdisk(env: Env, input: NetdiskProbeInput): Promise<void> {
  const policy: StoragePolicyRow = {
    id: 0,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    name: input.name ?? 'probe',
    type: input.type,
    server: null,
    bucket_name: input.bucket_name ?? null,
    is_private: false,
    max_size: 0,
    dir_name_rule: null,
    file_name_rule: null,
    access_key: input.access_key ?? null,
    secret_key: input.secret_key ?? null,
    settings: (input.settings ?? {}) as StoragePolicyRow['settings'],
    node_id: null,
  };
  const driver = createNetdiskDriver(env, policy) as StorageDriver & { probe?: () => Promise<void> };
  if (typeof driver.probe !== 'function') {
    throw new Error(`策略类型 ${input.type} 不支持连接测试`);
  }
  await driver.probe();
}
