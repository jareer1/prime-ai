import dotenv from "dotenv";

dotenv.config();

const config = {
  port: process.env.PORT || 3000,
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini"
  },
  brave: {
    apiKey: process.env.BRAVE_API_KEY
  }
};

const requiredEnvVars = ["OPENAI_API_KEY"];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

export default config;
