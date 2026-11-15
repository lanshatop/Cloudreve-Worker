import {
  Button,
  FormControl,
  FormControlLabel,
  Link,
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
 * WebDAV 存储策略创建向导（边缘版原生驱动，RFC 4918）。
 *
 * 与网盘网桥不同：WebDAV 是开放标准，Worker 直接对目标服务发
 * PUT / PROPFIND / MKCOL / GET / DELETE，不需要额外部署任何服务。
 * 创建时后端会先做一次只读 PROPFIND 连通性测试，凭据或地址填错会直接
 * 给出可操作的错误提示，不会落库。
 */
const WEBDAV_PRESETS: Record<string, { label: string; url: string; hint: string }> = {
  custom: {
    label: "自定义 / 通用",
    url: "",
    hint: "填完整的 WebDAV 根地址，结尾建议带 /。",
  },
  nextcloud: {
    label: "Nextcloud / ownCloud",
    url: "https://example.com/remote.php/dav/files/USERNAME/",
    hint: "USERNAME 换成 Nextcloud 登录名；密码请用「设置 → 安全 → 创建应用密码」，不要填主密码。",
  },
  jianguoyun: {
    label: "坚果云",
    url: "https://dav.jianguoyun.com/dav/",
    hint: "用户名是坚果云账号邮箱；密码必须用「账户信息 → 安全选项 → 添加应用」生成的应用密码。",
  },
  alist: {
    label: "AList / OpenList",
    url: "https://example.com/dav/",
    hint: "对端需开启 WebDAV 功能；默认端口路径为 /dav。挂载子目录可填 /某个挂载点。",
  },
  synology: {
    label: "群晖 NAS",
    url: "https://example.com:5006/",
    hint: "在「控制面板 → 文件服务 → WebDAV」启用 HTTPS 端口（默认 5006），必须是公网可信证书。",
  },
};

const MB = 1024 * 1024;

const WebDavWizard = ({ onSubmit }: AddWizardProps) => {
  const [policy, setPolicy] = useState<StoragePolicy>({
    id: 0,
    name: "WebDAV 存储",
    type: PolicyType.webdav,
    edges: {},
    server: "",
    bucket_name: "cloudreve",
    max_size: 95 * MB,
    settings: {},
  });
  const [preset, setPreset] = useState("custom");
  const [authMode, setAuthMode] = useState<"basic" | "bearer">("basic");
  const [maxMb, setMaxMb] = useState("95");
  const [headersText, setHeadersText] = useState("");
  const [skipProbe, setSkipProbe] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const update = (patch: Partial<StoragePolicy>) => setPolicy((p) => ({ ...p, ...patch }));

  let parsedHeaders: Record<string, string> | null = null;
  let headersError = "";
  if (headersText.trim()) {
    try {
      const v = JSON.parse(headersText);
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        headersError = "需要是一个 JSON 对象，例如 {\"X-App-Token\":\"abc\"}";
      } else if (Object.values(v).some((x) => typeof x !== "string")) {
        headersError = "每个请求头的值都必须是字符串";
      } else {
        parsedHeaders = v as Record<string, string>;
      }
    } catch {
      headersError = "JSON 格式不正确";
    }
  }

  const token = policy.settings?.token ?? "";
  const canSubmit =
    !submitting &&
    !!policy.name.trim() &&
    !!policy.server?.trim() &&
    !headersError &&
    (authMode === "bearer"
      ? !!token.trim()
      : !!(policy.access_key?.trim() && policy.secret_key?.trim()));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        const server = policy.server!.trim().replace(/\/+$/, "") + "/";
        const cleaned: StoragePolicy = {
          ...policy,
          server,
          bucket_name: (policy.bucket_name ?? "").trim(),
          max_size: Math.max(1, Number(maxMb) || 95) * MB,
          settings: {
            ...policy.settings,
            ...(authMode === "bearer" ? { token: token.trim() } : { token: "" }),
            ...(parsedHeaders ? { dav_headers: parsedHeaders } : {}),
            dav_skip_probe: skipProbe,
          },
          ...(authMode === "bearer" ? { access_key: "", secret_key: "" } : {}),
        };
        onSubmit(cleaned);
      }}
    >
      <Stack spacing={1}>
        <Typography variant="body2" color="textSecondary">
          本站直接以 WebDAV 协议（RFC 4918）读写你的远程存储，不需要额外部署网桥服务。
          支持 Nextcloud、坚果云、AList / OpenList、群晖等标准 WebDAV 服务；
          上传与下载都经 Worker 中转，凭据不会下发到浏览器。
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
        <SettingForm title="常见服务预设" lgWidth={12}>
          <FormControl fullWidth>
            <Select
              value={preset}
              onChange={(e) => {
                const key = e.target.value as string;
                setPreset(key);
                const p = WEBDAV_PRESETS[key];
                if (p?.url) update({ server: p.url });
              }}
            >
              {Object.entries(WEBDAV_PRESETS).map(([key, item]) => (
                <MenuItem key={key} value={key}>
                  {item.label}
                </MenuItem>
              ))}
            </Select>
            <NoMarginHelperText>{WEBDAV_PRESETS[preset]?.hint}</NoMarginHelperText>
          </FormControl>
        </SettingForm>
        <SettingForm title="WebDAV 服务地址" lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              required
              value={policy.server ?? ""}
              onChange={(e) => {
                setPreset("custom");
                update({ server: e.target.value });
              }}
            />
            <NoMarginHelperText>
              公网 HTTPS 地址（不能是内网 IP），结尾建议带 /。例如{" "}
              https://dav.example.com/remote.php/dav/files/alice/ 。
              发生 301/302 重定向时流式上传会失败，请直接填最终地址。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
        <SettingForm title="挂载子目录" lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              value={policy.bucket_name ?? ""}
              onChange={(e) => update({ bucket_name: e.target.value })}
            />
            <NoMarginHelperText>
              所有对象都写在该地址下的这个子目录里（默认 cloudreve，可留空表示根目录）。
              目录不存在时会自动逐级 MKCOL 创建。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
        <SettingForm title="认证方式" lgWidth={12}>
          <FormControl fullWidth>
            <Select
              value={authMode}
              onChange={(e) => setAuthMode(e.target.value as "basic" | "bearer")}
            >
              <MenuItem value="basic">用户名 + 密码（Basic）</MenuItem>
              <MenuItem value="bearer">Bearer Token</MenuItem>
            </Select>
            <NoMarginHelperText>
              只支持 Basic / Bearer，不支持 Digest。坚果云、Nextcloud 请使用应用专用密码。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
        {authMode === "bearer" ? (
          <SettingForm title="Bearer Token" lgWidth={12}>
            <FormControl fullWidth>
              <DenseFilledTextField
                required
                type="password"
                value={token}
                onChange={(e) => update({ settings: { ...policy.settings, token: e.target.value } })}
              />
              <NoMarginHelperText>会作为 Authorization: Bearer &lt;token&gt; 发送</NoMarginHelperText>
            </FormControl>
          </SettingForm>
        ) : (
          <>
            <SettingForm title="用户名" lgWidth={12}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  required
                  value={policy.access_key ?? ""}
                  onChange={(e) => update({ access_key: e.target.value })}
                />
                <NoMarginHelperText>WebDAV 账号名，坚果云为账号邮箱</NoMarginHelperText>
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
                <NoMarginHelperText>建议使用应用专用密码，不要填主账号密码</NoMarginHelperText>
              </FormControl>
            </SettingForm>
          </>
        )}
        <SettingForm title="自定义请求头（可选，JSON）" lgWidth={12}>
          <FormControl fullWidth error={!!headersError}>
            <DenseFilledTextField
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={'{"X-App-Token":"abc"}'}
            />
            <NoMarginHelperText>
              {headersError ||
                "少数服务需要额外请求头或自定义 User-Agent。键名只允许字母、数字和连字符。"}
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
        <SettingForm title="单文件上限（MB）" lgWidth={12}>
          <FormControl fullWidth>
            <DenseFilledTextField
              type="number"
              value={maxMb}
              onChange={(e) => setMaxMb(e.target.value)}
            />
            <NoMarginHelperText>
              WebDAV 无分片协议，整个文件一次经 Worker 流式转发；免费档请求体上限 100 MB，
              建议不超过 95。不支持断点续传 / 秒传 / 缩略图。
            </NoMarginHelperText>
          </FormControl>
        </SettingForm>
        <FormControlLabel
          control={
            <Switch checked={skipProbe} onChange={(e) => setSkipProbe(e.target.checked)} size="small" />
          }
          label={
            <Typography variant="body2" color="textSecondary">
              跳过创建时的连接测试（对端暂时不可达时勾选）
            </Typography>
          }
        />
        <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
          点击「创建」时后端会先发一次只读 PROPFIND 检查地址与凭据：
          401 表示账号密码错误，404 表示根路径不存在，405 表示这不是 WebDAV 端点。
          参考{" "}
          <Link href="https://datatracker.ietf.org/doc/html/rfc4918" target="_blank" rel="noreferrer">
            RFC 4918
          </Link>
          ，更多排错见部署文档「WebDAV 存储」章节。
        </Typography>
      </Stack>
      <Button disabled={!canSubmit} variant="contained" color="primary" sx={{ mt: 2 }} type="submit">
        创建
      </Button>
    </form>
  );
};

export default WebDavWizard;
