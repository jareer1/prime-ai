import OpenAI from "openai";
import config from "../config.js";

const openAIClient = new OpenAI({ apiKey: config.openai.apiKey });

export class OpenAIService {
  static async createChatCompletion(messages, options = {}) {
    const defaultOptions = {
      model: config.openai.model,
      temperature: 0.1,
      max_tokens: 1000
    };

    return openAIClient.chat.completions.create({
      ...defaultOptions,
      ...options,
      messages
    });
  }
}
