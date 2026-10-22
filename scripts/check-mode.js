#!/usr/bin/env node
import process from 'node:process';
import { loadAmbientEnv } from './shared.js';
import { MODELS, apiBase } from './models.mjs';
await loadAmbientEnv();
const rawFlag=String(process.env.ENABLE_GARDEN_IMAGEGEN||'').trim().toLowerCase();
const enabled=['1','true','yes','on','y'].includes(rawFlag), hasKey=Boolean(process.env.OPENAI_API_KEY);
const base=apiBase(process.env.OPENAI_BASE_URL||'https://vip.brioi.com/v1');
const result={
  mode:enabled&&hasKey?'A':enabled?'A?':'B-or-C',
  recommendation:enabled&&hasKey?'api-select-model':enabled?'api-missing-key':'host-or-api-setup',
  garden_mode_enabled:enabled,has_api_key:hasKey,base_url:base,
  configured_model_hint:process.env.OPENAI_IMAGE_MODEL||null,
  requires_model_selection:true,supported_models:MODELS,
  missing_config:[...(!enabled?['ENABLE_GARDEN_IMAGEGEN=1']:[]),...(!hasKey?['OPENAI_API_KEY']:[])],
  summary:enabled&&hasKey?'第三方API配置齐全；未指定模型时先让用户按名称选择，当前批次只选一次。':
    '若宿主有图片工具，可按宿主模式执行；没有时引导配置本地.env并选择第三方模型。用户不配置时才仅交付提示词。',
};
console.log(JSON.stringify(result,null,2));
