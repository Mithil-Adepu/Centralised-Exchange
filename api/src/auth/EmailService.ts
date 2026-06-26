import crypto from "crypto";

/* ═══════════════════════════════════════════════════════════════
   EmailService — Production-ready email with dev fallback.

   When SMTP_HOST is set → sends real emails via nodemailer.
   When SMTP_HOST is NOT set → logs OTP to console (dev mode).

   Supports: Gmail, SendGrid, Resend, Mailgun, any SMTP provider.

   Gmail setup:
     SMTP_HOST=smtp.gmail.com
     SMTP_PORT=587
     SMTP_USER=your@gmail.com
     SMTP_PASS=your-app-password  (NOT your Gmail password)
     SMTP_FROM=your@gmail.com
   ═══════════════════════════════════════════════════════════════ */

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@cex.io";
const SMTP_SECURE = process.env.SMTP_SECURE === "true"; // true for 465, false for 587

let transporter: any = null;

async function getTransporter() {
    if (transporter) return transporter;
    if (!SMTP_HOST) return null;

    // Dynamic import — nodemailer is optional dependency
    try {
        const nodemailer = await import("nodemailer");
        transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS,
            },
        });

        // Verify connection
        await transporter.verify();
        console.log(`[EMAIL] SMTP connected: ${SMTP_HOST}:${SMTP_PORT}`);
        return transporter;
    } catch (err: any) {
        console.error(`[EMAIL] SMTP connection failed: ${err?.message}`);
        console.warn("[EMAIL] Falling back to console-only mode");
        transporter = null;
        return null;
    }
}

function generateOTP(): string {
    return crypto.randomInt(100000, 999999).toString();
}

export class EmailService {
    private static instance: EmailService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new EmailService();
        }
        return this.instance;
    }

    /**
     * Generate a 6-digit OTP for an email.
     * Returns the OTP string (caller stores it in Redis).
     */
    generateOTP(): string {
        return generateOTP();
    }

    /**
     * Send an OTP email. Falls back to console logging in dev.
     */
    async sendOTP(email: string, otp: string, purpose: "verify" | "reset"): Promise<void> {
        const subject = purpose === "verify"
            ? "CEX — Verify your email"
            : "CEX — Password reset code";

        const body = purpose === "verify"
            ? `Your email verification code is:\n\n    ${otp}\n\nThis code expires in 5 minutes. If you didn't request this, ignore this email.`
            : `Your password reset code is:\n\n    ${otp}\n\nThis code expires in 5 minutes. If you didn't request this, ignore this email.`;

        const htmlBody = purpose === "verify"
            ? this.htmlTemplate("Verify Your Email", otp, "Enter this code to verify your email address.")
            : this.htmlTemplate("Password Reset", otp, "Enter this code to reset your password.");

        const transport = await getTransporter();

        if (transport) {
            try {
                await transport.sendMail({
                    from: SMTP_FROM,
                    to: email,
                    subject,
                    text: body,
                    html: htmlBody,
                });
                console.log(`[EMAIL] OTP sent to ${email} (${purpose})`);
            } catch (err: any) {
                console.error(`[EMAIL] Failed to send to ${email}: ${err?.message}`);
                // Still log OTP to console as fallback
                console.log(`[EMAIL-FALLBACK] OTP for ${email} (${purpose}): ${otp}`);
            }
        } else {
            // Dev mode: log to console
            console.log(`\n${"═".repeat(50)}`);
            console.log(`📧 [DEV EMAIL] ${purpose.toUpperCase()} OTP`);
            console.log(`   To: ${email}`);
            console.log(`   Code: ${otp}`);
            console.log(`   Expires: 5 minutes`);
            console.log(`${"═".repeat(50)}\n`);
        }
    }

    private htmlTemplate(title: string, otp: string, description: string): string {
        return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0e0f14; color: #e0e0e0; padding: 40px 20px;">
  <div style="max-width: 420px; margin: 0 auto; background: #1a1b23; border-radius: 12px; padding: 32px; border: 1px solid #2a2b35;">
    <h2 style="color: #ffffff; margin: 0 0 8px; font-size: 20px;">${title}</h2>
    <p style="color: #9ca3af; margin: 0 0 24px; font-size: 14px;">${description}</p>
    <div style="background: #0e0f14; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
      <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #ffffff;">${otp}</span>
    </div>
    <p style="color: #6b7280; font-size: 12px; margin: 0;">This code expires in 5 minutes.<br>If you didn't request this, you can safely ignore this email.</p>
  </div>
</body>
</html>`;
    }
}
