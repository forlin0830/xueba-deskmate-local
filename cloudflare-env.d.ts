declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    DASHSCOPE_API_KEY?: string;
    DASHSCOPE_INTL_API_KEY?: string;
    QWEN_MODEL?: string;
    ZHIPU_API_KEY?: string;
    GLM_MODEL?: string;
    TEACHER_CREDENTIAL_SEAL?: string;
  }
}
