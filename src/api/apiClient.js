// Shim: re-export Base44 equivalents so legacy imports from api/apiClient still work.
import { base44 } from '@/api/base44Client';

export const FilingAnalysis = base44.entities.FilingAnalysis;

export const functions = {
  invoke: async (name, body) => {
    return base44.functions.invoke(name, body);
  },
};

export const llm = {
  invoke: async ({ prompt, response_json_schema, model, file_urls }) => {
    return base44.integrations.Core.InvokeLLM({ prompt, response_json_schema, model, file_urls });
  },
};

export const getGeminiApiKey = () => null;
export const setGeminiApiKey = () => {};

export const uploadFile = async ({ file }) => {
  return base44.integrations.Core.UploadFile({ file });
};