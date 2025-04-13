import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "node:fs";
import path from "path";
import nodemailer from 'nodemailer';
import type { SentMessageInfo } from 'nodemailer';

// Load environment variables
dotenv.config();

// Gemini API setup
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error('GEMINI_API_KEY environment variable is not set');
}

// Initialize the Google Generative AI client with the beta endpoint
// @ts-ignore - Ignore TypeScript errors for the custom initialization
const genAI = new GoogleGenerativeAI(apiKey, {
  apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta'
});

// Use the Gemini Flash 2 model
// @ts-ignore - Ignore TypeScript errors for the beta model
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash"
});

// Configuration with appropriate settings for the model
// @ts-ignore - Ignore TypeScript errors for beta features
const generationConfig = {
  temperature: 0.7,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 65536
};

// Ensure output directory exists
const outputDir = path.join(process.cwd(), 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Create server instance
const server = new Server(
  {
    name: "gemini-email-subject-generator",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Schema for generate-thinking tool
const GenerateThinkingSchema = z.object({
  prompt: z.string().describe('Prompt for generating thinking process text'),
  outputDir: z.string().optional().describe('Directory to save output responses'),
});

// Schema for email sending tool
const SendEmailSchema = z.object({
  to: z.string().describe('Recipient email address'),
  subjectPrompt: z.string().describe('Prompt for Gemini to generate email subject'),
  text: z.string().describe('Plain text version of the email'),
  html: z.string().optional().describe('HTML version of the email'),
  images: z.array(z.object({
    name: z.string().describe('Image filename'),
    data: z.string().describe('Base64 encoded image data with mime type (data:image/jpeg;base64,...)')
  })).optional().default([]).describe('Images to attach to the email')
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "generate-thinking",
        description: "Generate detailed thinking process text using Gemini Flash 2 model",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Prompt for generating thinking process text",
            },
            outputDir: {
              type: "string",
              description: "Directory to save output responses (optional)",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "send-email",
        description: "Send an email with AI-generated subject using Gemini Flash 2",
        inputSchema: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: "Recipient email address"
            },
            subjectPrompt: {
              type: "string",
              description: "Prompt for Gemini to generate email subject"
            },
            text: {
              type: "string",
              description: "Plain text version of the email"
            },
            html: {
              type: "string",
              description: "HTML version of the email (optional)"
            },
            images: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Image filename"
                  },
                  data: {
                    type: "string",
                    description: "Base64 encoded image data with mime type (data:image/jpeg;base64,...)"
                  }
                },
                required: ["name", "data"]
              },
              description: "Images to attach to the email (optional)"
            }
          },
          required: ["to", "subjectPrompt", "text"]
        }
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "generate-thinking": {
        const { prompt, outputDir: customOutputDir } = GenerateThinkingSchema.parse(args);
        const saveDir = customOutputDir ? path.resolve(customOutputDir) : outputDir;
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }
        
        // Generate content with Gemini
        console.error(`Sending prompt to Gemini: "${prompt}"`);
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        console.error(`Received response from Gemini (${responseText.length} chars)`);
        
        // Save the response to a file
        const timestamp = Date.now();
        const filename = `gemini_thinking_${timestamp}.txt`;
        const filePath = path.join(saveDir, filename);
        fs.writeFileSync(filePath, responseText);
        console.error(`Saved response to: ${filePath}`);

        // Format the response as HTML
        // Convert markdown-like syntax to HTML
        let htmlResponse = responseText
          // Convert headers
          .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
          .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
          .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
          .replace(/^#### (.*?)$/gm, '<h4>$1</h4>')
          // Convert bold and italic
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          // Convert lists
          .replace(/^- (.*?)$/gm, '<li>$1</li>')
          // Convert code blocks
          .replace(/```(.*?)```/gs, '<pre><code>$1</code></pre>')
          // Convert paragraphs (lines with content)
          .replace(/^([^<\s].*?)$/gm, '<p>$1</p>');
        
        // Wrap lists in <ul> tags
        htmlResponse = htmlResponse.replace(/<li>.*?<\/li>/gs, match => {
          return '<ul>' + match + '</ul>';
        });
        
        // Fix nested lists
        htmlResponse = htmlResponse.replace(/<\/ul>\s*<ul>/g, '');

        // Wrap the response in a styled div
        const styledHtmlResponse = `
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.5; color: #333;">
  <div style="background-color: #f0f8ff; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #4169e1;">
    <h2 style="margin-top: 0; color: #4169e1;">Gemini Thinking Response</h2>
    <p style="font-style: italic; color: #666;">Generated based on prompt: "${prompt}"</p>
  </div>

  <div style="background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    ${htmlResponse}
  </div>
  
  <div style="background-color: #f5f5f5; padding: 10px; border-radius: 8px; margin-top: 20px; font-size: 0.9em; color: #666;">
    <p>Response saved to: ${filePath}</p>
  </div>
</div>`;

        return {
          content: [
            {
              type: "text",
              text: styledHtmlResponse,
            },
          ],
        };
      }

      case "send-email": {
        const { to, subjectPrompt, text, html, images } = SendEmailSchema.parse(args);
        
        // Generate email subject using Gemini Flash 2 with improved prompt
        console.error(`Generating email subject using prompt: "${subjectPrompt}"`);
        
        // Create a more specific prompt that emphasizes professional formatting
        const enhancedPrompt = `Create a single, professional email subject line (maximum 50-60 characters) for: ${subjectPrompt}. 
        The subject should be direct, clear, and professional. 
        Do not include numbering, asterisks, or formatting characters. 
        Do not provide multiple options - just give me one perfect subject line.
        Do not include phrases like "Subject line:" or "Email subject:" in your response.`;
        
        const subjectResult = await model.generateContent(enhancedPrompt);
        let generatedSubject = subjectResult.response.text();
        
        // Advanced cleanup for the generated subject
        generatedSubject = generatedSubject
          // Remove any remaining formatting markers
          .replace(/\*\*|\*|__|_/g, '')
          // Remove phrases like "Subject line:" or "Email subject:"
          .replace(/^(subject|subject line|email subject|title)(:|\s-)\s*/i, '')
          // Remove quotes if they wrap the entire subject
          .replace(/^["'](.+)["']$/, '$1')
          // Remove any line breaks and extra whitespace
          .replace(/\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        // If the result is still problematic, try a simpler approach
        if (generatedSubject.length > 70 || generatedSubject.length < 10 || 
            generatedSubject.includes("Option") || generatedSubject.includes("**")) {
          
          const fallbackPrompt = `Create a brief, professional email subject line (30-50 characters only) about: ${subjectPrompt}. 
          Just return the subject line text alone with no formatting or explanation.`;
          
          const fallbackResult = await model.generateContent(fallbackPrompt);
          generatedSubject = fallbackResult.response.text()
            .replace(/\*\*|\*|__|_/g, '')
            .replace(/^(subject|subject line|email subject|title)(:|\s-)\s*/i, '')
            .replace(/^["'](.+)["']$/, '$1')
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          // Final length check and truncation if needed
          if (generatedSubject.length > 70) {
            generatedSubject = generatedSubject.substring(0, 67) + '...';
          }
        }
        
        console.error(`Generated subject: "${generatedSubject}"`);
        
        // Check if email credentials are set
        const emailUser = process.env.NODEMAILER_EMAIL;
        const emailPass = process.env.NODEMAILER_PASSWORD;
        
        if (!emailUser || !emailPass) {
          throw new Error('Email credentials (NODEMAILER_EMAIL and NODEMAILER_PASSWORD) are not set in environment variables');
        }
        
        // Configure email transporter
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: emailUser,
            pass: emailPass,
          },
        });
        
        // Prepare attachments from images
        const attachments = images
          .map((image, index) => {
            const matches = image.data.match(/^data:(.+);base64,(.+)$/);
            if (matches) {
              const [, type, base64Data] = matches;
              return {
                filename: image.name,
                content: base64Data,
                encoding: 'base64' as const,
                cid: `image${index}`,
                contentType: type
              };
            }
            return null;
          })
          .filter((attachment): attachment is {
            filename: string;
            content: string;
            encoding: 'base64';
            cid: string;
            contentType: string;
          } => attachment !== null);
        
        // Define the email options with improved HTML formatting
        // Create a professionally formatted HTML version if only text was provided
        let htmlContent = html;
        if (!htmlContent && text) {
          // Convert plain text to professional HTML with styling
          htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${generatedSubject}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 650px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      border-bottom: 2px solid #4169E1;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    .header h1 {
      color: #4169E1;
      font-size: 24px;
      margin: 0;
    }
    .content {
      padding: 15px 0;
    }
    .footer {
      margin-top: 30px;
      padding-top: 10px;
      border-top: 1px solid #eee;
      font-size: 12px;
      color: #777;
    }
    p {
      margin: 0 0 15px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${generatedSubject}</h1>
  </div>
  <div class="content">
    ${text.split('\n').map(line => `<p>${line}</p>`).join('')}
  </div>
  <div class="footer">
    <p>This email was sent using Gemini Email Subject Generator</p>
  </div>
</body>
</html>`;
        }
        
        const mailOptions: nodemailer.SendMailOptions = {
          from: emailUser,
          to,
          subject: generatedSubject,
          text,
          html: htmlContent || text,
          attachments
        };
        
        try {
          // Send the email
          console.error(`Sending email to ${to}`);
          const info: SentMessageInfo = await transporter.sendMail(mailOptions);
          console.error(`Email sent, message ID: ${info.messageId}`);
          
          return {
            content: [
              {
                type: "text",
                text: `<div style="font-family: Arial, sans-serif; padding: 20px; border-radius: 10px; border: 1px solid #e0e0e0; background-color: #f9f9f9; max-width: 600px; margin: 0 auto;">
  <div style="background-color: #4CAF50; color: white; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px;">
    <h2 style="margin: 0; font-size: 18px;">✅ Email Successfully Sent</h2>
  </div>
  
  <div style="padding: 10px; background-color: white; border-radius: 5px; margin-bottom: 15px;">
    <p><strong>To:</strong> ${to}</p>
    <p><strong>Subject:</strong> "${generatedSubject}"</p>
    <p><strong>Message ID:</strong> ${info.messageId}</p>
  </div>
  
  <div style="background-color: #f0f0f0; padding: 10px; border-radius: 5px; border-left: 3px solid #4CAF50;">
    <p>The email has been delivered with your provided content.</p>
    <p style="font-style: italic; color: #666;">Note: This is just a confirmation message displayed here, not the actual email content.</p>
  </div>
</div>`
              }
            ]
          };
        } catch (error) {
          console.error(`Error sending email:`, error);
          return {
            content: [
              {
                type: "text",
                text: `<div style="font-family: Arial, sans-serif; padding: 20px; border-radius: 10px; border: 1px solid #e0e0e0; background-color: #fff0f0; max-width: 600px; margin: 0 auto;">
  <div style="background-color: #f44336; color: white; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px;">
    <h2 style="margin: 0; font-size: 18px;">❌ Email Sending Failed</h2>
  </div>
  
  <div style="padding: 15px; background-color: white; border-radius: 5px;">
    <p><strong>Error:</strong> ${error instanceof Error ? error.message : String(error)}</p>
    <p>Please check your email credentials and try again.</p>
  </div>
</div>`
              }
            ]
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Error in tool execution:`, error);
    throw error;
  }
});

// Start the server
async function main() {
  try {
    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Gemini Email Subject Generator MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main();