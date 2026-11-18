// [edge patch·新增] 文件页顶栏「存储策略」切换器（edge 自建 Pro 功能）。
//
// 后端 list 响应里有多个可选策略（storage_policies）时，在「视图 / 排序」
// 按钮旁渲染一个与它们同款样式的云朵图标按钮（悬停 Tooltip 显示当前策略，
// 避免整行策略名挤换行破坏顶栏布局），点开下拉即可在组内多个存储策略间
// 切换。切换后把选中的策略 hashid 写进用户设置（PATCH /user/setting 的
// upload_policy_id），再刷新当前列表 —— 列表刷新会让上传器经
// list.storage_policy 拿到新策略，后续上传即落到所选存储。
// 只有一个可选策略时不渲染，与上游行为一致。
import CloudFilled from "../../Icons/CloudFilled.tsx";
import { ActionButton } from "./TopActions.tsx";
import { Box, Divider, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import { bindMenu, bindTrigger, usePopupState } from "material-ui-popup-state/hooks";
import { useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import { sendUpdateUserSetting } from "../../../api/api.ts";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks.ts";
import { refreshFileList } from "../../../redux/thunks/filemanager.ts";
import { FmIndexContext } from "../FmIndexContext.tsx";

interface PolicyBrief {
  id: string;
  name: string;
  type?: string;
}

const PolicySwitcher = () => {
  const { t } = useTranslation();
  const fmIndex = useContext(FmIndexContext);
  const dispatch = useAppDispatch();
  const list = useAppSelector((state) => state.fileManager[fmIndex].list);
  const policies = (list?.storage_policies as unknown as PolicyBrief[] | undefined) ?? [];
  const current = list?.storage_policy as unknown as PolicyBrief | undefined;
  const popupState = usePopupState({ variant: "menu", popupId: "policySwitcher" });
  const label = t("application:fileManager.storagePolicy", "存储策略");

  const onSelect = useCallback(
    (id: string) => {
      popupState.close();
      dispatch(sendUpdateUserSetting({ upload_policy_id: id } as never)).then(() => {
        dispatch(refreshFileList(fmIndex));
      });
    },
    [dispatch, fmIndex, popupState],
  );

  if (policies.length < 2 || !current) return null;

  return (
    <>
      <Tooltip title={`${label}：${current.name}`} enterDelay={300} enterNextDelay={300}>
        <ActionButton
          aria-label={`${label}：${current.name}`}
          sx={{ px: 1.2, minWidth: 0 }}
          {...bindTrigger(popupState)}
        >
          <CloudFilled fontSize="small" />
        </ActionButton>
      </Tooltip>
      <Menu
        {...bindMenu(popupState)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
          <Typography variant="caption" color="textSecondary">
            {label}
          </Typography>
        </Box>
        <Divider />
        {policies.map((p) => (
          <MenuItem key={p.id} selected={p.id === current.id} onClick={() => onSelect(p.id)}>
            <Box sx={{ display: "flex", flexDirection: "column" }}>
              <Typography variant="body2" fontWeight={600}>
                {p.name}
                {p.id === current.id && " ✓"}
              </Typography>
              {p.type && (
                <Typography variant="caption" color="textSecondary">
                  {t(`policy.${p.type}`, p.type)}
                </Typography>
              )}
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

export default PolicySwitcher;
