import { UserInput, LifeDestinyResult, Gender } from "../types";
import { BAZI_SYSTEM_INSTRUCTION } from "../constants";

// Helper to determine stem polarity
const getStemPolarity = (pillar: string): 'YANG' | 'YIN' => {
  if (!pillar) return 'YANG'; // default
  const firstChar = pillar.trim().charAt(0);
  const yangStems = ['甲', '丙', '戊', '庚', '壬'];
  const yinStems = ['乙', '丁', '己', '辛', '癸'];
  
  if (yangStems.includes(firstChar)) return 'YANG';
  if (yinStems.includes(firstChar)) return 'YIN';
  return 'YANG'; // fallback
};

// Robust JSON extraction from model output
// Handles: raw JSON, markdown code blocks, text with embedded JSON
function extractJSON(content: string): any {
  // 1. Try direct parse first
  try {
    return JSON.parse(content);
  } catch {}

  // 2. Try extracting from markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
    // If the code block failed, try to find JSON inside it
    const innerJSON = codeBlockMatch[1].match(/\{[\s\S]*\}/);
    if (innerJSON) {
      try {
        return JSON.parse(innerJSON[0]);
      } catch {}
    }
  }

  // 3. Try to find a JSON object in the content (greedy match outermost braces)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Try to fix common issues: trailing commas, unescaped chars
      let fixed = jsonMatch[0]
        .replace(/,\s*\}/g, '}')  // remove trailing commas
        .replace(/,\s*\]/g, ']'); // remove trailing commas in arrays
      try {
        return JSON.parse(fixed);
      } catch {}
    }
  }

  throw new Error("无法从模型返回中提取有效的 JSON 数据。请尝试更换模型或重试。\n\n原始返回片段: " + content.substring(0, 500));
}

// Detect if the model is likely DeepSeek (which has different API behavior)
function isDeepSeekModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('deepseek');
}

export const generateLifeAnalysis = async (input: UserInput): Promise<LifeDestinyResult> => {
  
  const { apiKey, apiBaseUrl, modelName } = input;

  if (!apiKey || !apiKey.trim()) {
    throw new Error("请在表单中填写有效的 API Key");
  }
  if (!apiBaseUrl || !apiBaseUrl.trim()) {
    throw new Error("请在表单中填写有效的 API Base URL");
  }

  // Remove trailing slash if present
  const cleanBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  // Use user provided model name or fallback
  const targetModel = modelName && modelName.trim() ? modelName.trim() : "deepseek-chat";

  const genderStr = input.gender === Gender.MALE ? '男 (乾造)' : '女 (坤造)';
  const startAgeInt = parseInt(input.startAge) || 1;
  
  // Calculate Da Yun Direction accurately
  const yearStemPolarity = getStemPolarity(input.yearPillar);
  let isForward = false;

  if (input.gender === Gender.MALE) {
    isForward = yearStemPolarity === 'YANG';
  } else {
    isForward = yearStemPolarity === 'YIN';
  }

  const daYunDirectionStr = isForward ? '顺行 (Forward)' : '逆行 (Backward)';
  
  const directionExample = isForward 
    ? "例如：第一步是【戊申】，第二步则是【己酉】（顺排）" 
    : "例如：第一步是【戊申】，第二步则是【丁未】（逆排）";

  const userPrompt = `
    请根据以下**已经排好的**八字四柱和**指定的大运信息**进行分析。
    
    【基本信息】
    性别：${genderStr}
    姓名：${input.name || "未提供"}
    出生年份：${input.birthYear}年 (阳历)
    
    【八字四柱】
    年柱：${input.yearPillar} (天干属性：${yearStemPolarity === 'YANG' ? '阳' : '阴'})
    月柱：${input.monthPillar}
    日柱：${input.dayPillar}
    时柱：${input.hourPillar}
    
    【大运核心参数】
    1. 起运年龄：${input.startAge} 岁 (虚岁)。
    2. 第一步大运：${input.firstDaYun}。
    3. **排序方向**：${daYunDirectionStr}。
    
    【必须执行的算法 - 大运序列生成】
    请严格按照以下步骤生成数据：
    
    1. **锁定第一步**：确认【${input.firstDaYun}】为第一步大运。
    2. **计算序列**：根据六十甲子顺序和方向（${daYunDirectionStr}），推算出接下来的 9 步大运。
       ${directionExample}
    3. **填充 JSON**：
       - Age 1 到 ${startAgeInt - 1}: daYun = "童限"
       - Age ${startAgeInt} 到 ${startAgeInt + 9}: daYun = [第1步大运: ${input.firstDaYun}]
       - Age ${startAgeInt + 10} 到 ${startAgeInt + 19}: daYun = [第2步大运]
       - Age ${startAgeInt + 20} 到 ${startAgeInt + 29}: daYun = [第3步大运]
       - ...以此类推直到 100 岁。
    
    【特别警告】
    - **daYun 字段**：必须填大运干支（10年一变），**绝对不要**填流年干支。
    - **ganZhi 字段**：填入该年份的**流年干支**（每年一变，例如 2024=甲辰，2025=乙巳）。
    
    任务：
    1. 确认格局与喜忌。
    2. 生成 **1-100 岁 (虚岁)** 的人生流年K线数据。
    3. 在 \`reason\` 字段中提供流年详批。
    4. 生成带评分的命理分析报告。
    
    【重要】你必须只输出纯 JSON，不要包含任何解释文字、markdown 标记或代码块符号。
    直接以 { 开头输出完整的 JSON 对象。
  `;

  try {
    // Build request body - DeepSeek doesn't support response_format json_object
    const requestBody: any = {
      model: targetModel, 
      messages: [
        { role: "system", content: BAZI_SYSTEM_INSTRUCTION },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7
    };
    
    // Only add response_format for models that support it (not DeepSeek)
    if (!isDeepSeekModel(targetModel)) {
      requestBody.response_format = { type: "json_object" };
    }

    const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API 请求失败: ${response.status} - ${errText}`);
    }

    const jsonResult = await response.json();
    const content = jsonResult.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("模型未返回任何内容，请检查 API Key 和 Base URL 是否正确。");
    }

    // 使用鲁棒的 JSON 提取
    const data = extractJSON(content);

    // 简单校验数据完整性
    if (!data.chartPoints || !Array.isArray(data.chartPoints)) {
      throw new Error("模型返回的数据格式不正确（缺失 chartPoints）。请尝试重新生成。");
    }

    return {
      chartData: data.chartPoints,
      analysis: {
        bazi: data.bazi || [],
        summary: data.summary || "无摘要",
        summaryScore: data.summaryScore || 5,
        industry: data.industry || "无",
        industryScore: data.industryScore || 5,
        wealth: data.wealth || "无",
        wealthScore: data.wealthScore || 5,
        marriage: data.marriage || "无",
        marriageScore: data.marriageScore || 5,
        health: data.health || "无",
        healthScore: data.healthScore || 5,
        family: data.family || "无",
        familyScore: data.familyScore || 5,
      },
    };
  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
};
