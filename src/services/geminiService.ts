import { GoogleGenAI, Type } from "@google/genai";
import { Word } from "../constants";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateMoreWords(existingWords: string[]): Promise<Word[]> {
  const prompt = `Generate 30 academic English words suitable for academic IELTS preparation (Band 7+). 
  These should be significant academic nouns, verbs, or adjectives.
  
  IMPORTANT: Do NOT include any of the following words as they are already in the library:
  ${existingWords.join(", ")}
  
  For each word, provide:
  - American English spelling (en)
  - British/Australian English spelling (en_gb)
  - Cantonese Chinese translation (zh)
  - A clear academic definition (definition)
  - The grammatical type (type): MUST be one of 'Noun', 'Verb', 'Adjective', or 'Adverb'. Do NOT use 'Academic' or 'Vocab'. Analyze the word carefully. (e.g., words ending in '-ize' or '-ate' are usually Verbs, '-tion' are Nouns, '-ive' are Adjectives).
  - The word level (level): Use 'Academic' as the level.
  - 3 high-quality example sentences in English reflecting academic or professional context (examples)
  
  Output exactly 30 unique words in JSON format matching the schema.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              en: { type: Type.STRING },
              en_gb: { type: Type.STRING },
              zh: { type: Type.STRING },
              definition: { type: Type.STRING },
              type: { 
                type: Type.STRING, 
                description: "The grammatical part of speech (Noun, Verb, Adjective, or Adverb).",
                enum: ["Noun", "Verb", "Adjective", "Adverb"] 
              },
              level: { type: Type.STRING, enum: ["Academic"] },
              examples: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                minItems: 3,
                maxItems: 3
              }
            },
            required: ["en", "en_gb", "zh", "definition", "type", "level", "examples"]
          }
        }
      }
    });

    const text = response.text;
    const wordsData = JSON.parse(text);
    
    // Assign incremental IDs starting from a high number to avoid collision with base list (1-150)
    // We'll handle exact ID assignment in the App component to ensure global uniqueness across sessions
    return wordsData.map((w: any, index: number) => ({
      ...w,
      id: Date.now() + index // Temporary ID, will be refined in App
    }));
  } catch (error) {
    console.error("Error generating words:", error);
    throw error;
  }
}
