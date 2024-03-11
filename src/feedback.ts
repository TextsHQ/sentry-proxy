import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

export async function sendFeedbackEmail() {
  const msg = createMimeMessage();
  msg.setSender({ name: "GPT-4", addr: "<SENDER>@example.com" });
  msg.setRecipient("<RECIPIENT>@example.com");
  msg.setSubject("An email generated in a worker");
  msg.addMessage({
    contentType: 'text/plain',
    data: `Congratulations, you just sent an email from a worker.`
  });

  var message = new EmailMessage(
    "<SENDER>@example.com",
    "<RECIPIENT>@example.com",
    msg.asRaw()
  );
  try {
    await env.SEB.send(message);
  } catch (e) {
    return new Response(e.message);
  }

  return new Response("Hello Send Email World!");
}
