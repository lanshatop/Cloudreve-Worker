import {
  Button,
  FormControl,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { StoragePolicy } from "../../../../../api/dashboard";
import { PolicyType } from "../../../../../api/explorer";
import { DenseFilledTextField } from "../../../../Common/StyledComponents";
import SettingForm from "../../../../Pages/Setting/SettingForm";
import { NoMarginHelperText } from "../../../Settings/Settings";
import { AddWizardProps } from "../../AddWizardDialog";

/**
 * 国内个人网盘（天翼 / 移动 / 联通 / 阿里云盘）创建向导。
 *
 * 四家都由本站 Worker **原生**读写：不需要再部署 OpenList / AList 之类的
 * 网桥服务。代价是每家都要一份自己的凭据（Cookie / token / authorization），
 * 所以这里按类型渲染不同表单。
 *
 * 上传形态统一为「整文件中转」：浏览器把文件作为一个整体 PUT 给 Worker，
 * 驱动内部再按各家协议切片直传（天翼 10 MB / 移动 100 MB / 联通 8 MB /
 * 阿里 10 MB）。因此单文件上限只需 ≤ 95 MB（免费档请求体 100 MiB）。
 */
export interface NetdiskWizardProps extends AddWizardProps {
  preset: PolicyType;
}

interface ProviderMeta {
  label: string;
  root: string;
  intro: string;
  /** 凭据获取指引 */
  guide: string;
  /** 是否有「账号密码」这种备选认证方式 */
  hasPasswordMode?: boolean;
  tokenLabel?: string;
  tokenHint?: string;
}

const MB = 1024 * 1024;

const PROVIDERS: Record<string, ProviderMeta> = {
  [PolicyType.cloud189]: {
    label: "天翼云盘",
    root: "/cloud189",
    intro:
      "直连 cloud.189.cn 的私有接口（OAuth2 登录 + AES/HMAC 上传签名），文件存在你的天翼云盘里。",
    guide:
      "推荐填浏览器 Cookie：在浏览器登录 cloud.189.cn → F12 → Network → 任意请求的 Cookie 整串复制。账号密码登录可能触发滑块/设备锁，届时只能用 Cookie。",
    hasPasswordMode: true,
    tokenLabel: "浏览器 Cookie（推荐）",
    tokenHint: "形如 COOKIE_LOGIN_USER=...; sessionKey=...; 不要带换行",
  },
  [PolicyType.yun139]: {
    label: "移动云盘",
    root: "/cloud139",
    intro:
      "直连 yun.139.com 新版个人云接口（mcloud-sign 签名）。上传前需整文件 SHA-256，因此会先用 R2 暂存一次。",
    guide:
      "浏览器登录 yun.139.com → F12 → Network → 任意 /file/ 请求 → 复制请求头 Authorization 里 Basic 后面那串（base64）。",
    tokenLabel: "authorization",
    tokenHint: "base64 字符串，不要带 “Basic ” 前缀",
  },
  [PolicyType.wopan]: {
    label: "联通云盘",
    root: "/wopan",
    intro:
      "直连联通「沃云」dispatcher 协议（AES-CBC 加密参数 + MD5 签名），分片走 upload2C 表单直传。",
    guide:
      "用沃盘 App 或 pan.wo.cn 网页登录后抓包取 access_token 与 refresh_token（请求头 Accesstoken + AppRefreshToken 响应）。token 约 2 小时过期，必须同时填 refresh_token。",
  },
  [PolicyType.aliyundrive]: {
    label: "阿里云盘",
    root: "/aliyun",
    intro:
      "走官方开放平台 OpenAPI（/adrive/v1.0），Bearer Token 鉴权，2 小时自动续期。这是四家里唯一有正式 API 的。",
    guide:
      "打开 https://alistgo.com/tool/aliyundrive/request 用阿里云盘 App 扫码授权，把页面给出的 refresh_token 填进来。注意：官方自 2025-07 起暂停个人开发者入驻，扫码发的 token 归社区公共应用，需把下方「token 接口地址」填为 https://api.alistgo.com/alist/ali_open/token（client_id / client_secret 留空）。",
    tokenLabel: "refresh_token（必填）",
    tokenHint: "扫码授权页给出的一长串，直接粘贴",
  },
};

const NetdiskWizard = ({ onSubmit, preset }: NetdiskWizardProps) => {
  const meta = PROVIDERS[preset] ?? PROVIDERS[PolicyType.cloud189];
  const [policy, setPolicy] = useState<StoragePolicy>({
    id: 0,
    name: `${meta.label} 存储`,
    type: preset,
    edges: {},
    server: "",
    bucket_name: meta.root,
    max_size: 95 * MB,
    settings: {},
  });
  const [authMode, setAuthMode] = useState<"token" | "password">("token");
  const [maxMb, setMaxMb] = useState("95");
  const [skipProbe, setSkipProbe] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const update = (patch: Partial<StoragePolicy>) => setPolicy((p) => ({ ...p, ...patch }));
  const updateSettings = (patch: Record<string, unknown>) =>
    setPolicy((p) => ({ ...p, settings: { ...p.settings, ...patch } }));

  const settings = policy.settings ?? {};
  const text = (key: string) => String(settings[key] ?? "");

  const credentialsReady = (() => {
    switch (preset) {
      case PolicyType.cloud189:
        return authMode === "token"
          ? !!text("c189_cookie").trim()
          : !!(policy.access_key?.trim() && policy.secret_key?.trim());
      case PolicyType.yun139:
        return !!text("y139_authorization").trim();
      case PolicyType.wopan:
        return !!(text("wp_access_token").trim() && text("wp_refresh_token").trim());
      case PolicyType.aliyundrive:
        return !!text("ali_refresh_token").trim();
      default:
        return false;
    }
  })();

  const canSubmit = !submitting && !!policy.name.trim() && credentialsReady;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        const cleaned: StoragePolicy = {
          ...policy,
          server: "",
          bucket_name: (policy.bucket_name ?? "").trim(),
          max_size: Math.max(1, Number(maxMb) || 95) * MB,
          settings: {
            ...settings,
            netdisk_skip_probe: skipProbe,
            ...(preset === PolicyType.cloud189 && authMode === "token"
              ? { c189_cookie: text("c189_cookie").trim() }
              : {}),
          },
          ...(preset === PolicyType.cloud189 && authMode === "token"
            ? { access_key: "", secret_key: "" }
            : {}),
        };
        onSubmit(cleaned);
      }}
    >
      <Stack spacing={1}>
        <Typography variant="body2" color="textSecondary">
          {meta.intro}
        </Typography>

        <SettingForm lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              required
              value={policy.name}
              onChange={(e) => update({ name: e.target.value })}
            />
            <NoMarginHelperText>策略名称</NoMarginHelperText>
          </FormControl>
        </SettingForm>

        <SettingForm title="挂载根路径" lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              value={policy.bucket_name ?? ""}
              onChange={(e) => update({ bucket_name: e.target.value })}
            />
            <NoMarginHelperText>
              本站的文件都写在这个目录下（默认 {meta.root}，留空表示网盘根目录）。
              目录不存在时会自动逐级创建。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>

        {/* ---------------- 天翼云盘 ---------------- */}
        {preset === PolicyType.cloud189 && (
          <>
            <SettingForm title="认证方式" lgWidth={12}>
              <FormControl fullWidth>
                <Select
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as "token" | "password")}
                >
                  <MenuItem value="token">浏览器 Cookie（推荐）</MenuItem>
                  <MenuItem value="password">账号 + 密码</MenuItem>
                </Select>
                <NoMarginHelperText>{meta.guide}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            {authMode === "token" ? (
              <SettingForm title={meta.tokenLabel} lgWidth={12}>
                <FormControl fullWidth>
                  <DenseFilledTextField
                    required
                    multiline
                    minRows={2}
                    value={text("c189_cookie")}
                    onChange={(e) => updateSettings({ c189_cookie: e.target.value })}
                  />
                  <NoMarginHelperText>{meta.tokenHint}</NoMarginHelperText>
                </FormControl>
              </SettingForm>
            ) : (
              <>
                <SettingForm title="天翼账号" lgWidth={12}>
                  <FormControl fullWidth>
                    <DenseFilledTextField
                      required
                      value={policy.access_key ?? ""}
                      onChange={(e) => update({ access_key: e.target.value })}
                    />
                    <NoMarginHelperText>手机号或邮箱</NoMarginHelperText>
                  </FormControl>
                </SettingForm>
                <SettingForm title="密码" lgWidth={12}>
                  <FormControl fullWidth>
                    <DenseFilledTextField
                      required
                      type="password"
                      value={policy.secret_key ?? ""}
                      onChange={(e) => update({ secret_key: e.target.value })}
                    />
                    <NoMarginHelperText>
                      触发滑块验证时无法自动登录，请改用 Cookie
                    </NoMarginHelperText>
                  </FormControl>
                </SettingForm>
              </>
            )}
            <SettingForm title="根目录 ID（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("c189_root_folder_id")}
                  onChange={(e) => updateSettings({ c189_root_folder_id: e.target.value })}
                />
                <NoMarginHelperText>默认 -11（个人云根目录），一般不用改</NoMarginHelperText>
              </FormControl>
            </SettingForm>
          </>
        )}

        {/* ---------------- 移动云盘 ---------------- */}
        {preset === PolicyType.yun139 && (
          <>
            <SettingForm title={meta.tokenLabel} lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  required
                  multiline
                  minRows={2}
                  value={text("y139_authorization")}
                  onChange={(e) => updateSettings({ y139_authorization: e.target.value })}
                />
                <NoMarginHelperText>{meta.guide}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="userDomainId（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("y139_user_domain_id")}
                  onChange={(e) => updateSettings({ y139_user_domain_id: e.target.value })}
                />
                <NoMarginHelperText>
                  填了才能通过 PC 接口自动续期；不填则在 token 过期后需要重新抓取
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="根目录 fileId（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("y139_root_folder_id")}
                  onChange={(e) => updateSettings({ y139_root_folder_id: e.target.value })}
                />
                <NoMarginHelperText>默认 “/”，即个人云根目录</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <Typography variant="body2" color="error">
              注意：移动云盘上传前要整文件 SHA-256，Worker 会先把文件暂存到 R2
              临时对象再分片上传（上传完即删）。没有绑定 R2 时该策略无法上传。
            </Typography>
          </>
        )}

        {/* ---------------- 联通云盘 ---------------- */}
        {preset === PolicyType.wopan && (
          <>
            <SettingForm title="access_token" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  required
                  type="password"
                  value={text("wp_access_token")}
                  onChange={(e) => updateSettings({ wp_access_token: e.target.value })}
                />
                <NoMarginHelperText>{meta.guide}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="refresh_token" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  required
                  type="password"
                  value={text("wp_refresh_token")}
                  onChange={(e) => updateSettings({ wp_refresh_token: e.target.value })}
                />
                <NoMarginHelperText>
                  access_token 约 2 小时过期，驱动会用 refresh_token 自动续期
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="根目录 ID（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("wp_root_folder_id")}
                  onChange={(e) => updateSettings({ wp_root_folder_id: e.target.value })}
                />
                <NoMarginHelperText>默认 0（个人云根目录）</NoMarginHelperText>
              </FormControl>
            </SettingForm>
          </>
        )}

        {/* ---------------- 阿里云盘 ---------------- */}
        {preset === PolicyType.aliyundrive && (
          <>
            <SettingForm title={meta.tokenLabel} lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  required
                  multiline
                  minRows={2}
                  value={text("ali_refresh_token")}
                  onChange={(e) => updateSettings({ ali_refresh_token: e.target.value })}
                />
                <NoMarginHelperText>{meta.guide}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="token 接口地址（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("ali_token_url")}
                  onChange={(e) => updateSettings({ ali_token_url: e.target.value })}
                  placeholder="https://api.alistgo.com/alist/ali_open/token"
                />
                <NoMarginHelperText>
                  留空用官方端点。社区扫码发的 token 请填
                  https://api.alistgo.com/alist/ali_open/token；此时 client_id / client_secret 留空。
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="client_id（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={policy.access_key ?? ""}
                  onChange={(e) => update({ access_key: e.target.value })}
                />
                <NoMarginHelperText>
                  留空使用内置公共 AppID；自建开放平台应用时填自己的
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="client_secret（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  type="password"
                  value={policy.secret_key ?? ""}
                  onChange={(e) => update({ secret_key: e.target.value })}
                />
                <NoMarginHelperText>与 client_id 配套</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="drive_id（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("ali_drive_id")}
                  onChange={(e) => updateSettings({ ali_drive_id: e.target.value })}
                />
                <NoMarginHelperText>留空自动识别（优先 resource drive）</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title="根目录 file_id（可选）" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={text("ali_root_folder_id")}
                  onChange={(e) => updateSettings({ ali_root_folder_id: e.target.value })}
                />
                <NoMarginHelperText>默认 root</NoMarginHelperText>
              </FormControl>
            </SettingForm>
          </>
        )}

        <SettingForm title="单文件上限（MB）" lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              type="number"
              value={maxMb}
              onChange={(e) => setMaxMb(e.target.value)}
            />
            <NoMarginHelperText>
              整个文件经 Worker 中转，免费档请求体上限 100 MB，建议不超过 95。
              不支持断点续传 / 秒传（天翼与移动的秒传由对端自动判断）。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>

        <FormControlLabel
          control={
            <Switch checked={skipProbe} onChange={(e) => setSkipProbe(e.target.checked)} size="small" />
          }
          label={
            <Typography variant="body2" color="textSecondary">
              跳过创建时的连接测试（对端限流 / 风控时勾选）
            </Typography>
          }
        />

        <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
          点「创建」时后端会用这份凭据做一次只读探测（登录 + 读根目录），
          失败不落库，错误信息里会指出是凭据过期还是网络不可达。
          四家网盘都是非官方接口（阿里云盘除外），接口变动可能导致失效 ——
          详细的抓取步骤与排错见部署文档「国内网盘接入」章节。
        </Typography>
      </Stack>
      <Button disabled={!canSubmit} variant="contained" color="primary" sx={{ mt: 2 }} type="submit">
        创建
      </Button>
    </form>
  );
};

export default NetdiskWizard;
