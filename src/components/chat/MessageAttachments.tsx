import type { ChatMessage } from "../../lib/ipc";
import { cardComponent, fileComponent } from "./cards";
import { CardFallback, KNOWN_CARD_KINDS } from "./cards/CardFallback";
import { UnknownCard } from "./cards/UnknownCard";

/**
 * --- slice: chat ---
 *
 * The files and cards of a message, under its text.
 *
 * --- slice: chat cards ---
 * A file is drawn by the component of its class — the picture, the video,
 * the demo — and by `FileCard` otherwise; a card by the component of its
 * type, and by `UnknownCard` for a type this launcher does not know.
 */
export function MessageAttachments({ message }: { message: ChatMessage }) {
  if (message.files.length === 0 && message.cards.length === 0) return null;
  return (
    <div className="flex max-w-full flex-col gap-6">
      {message.files.map((file) => {
        const File = fileComponent(file.class);
        return <File key={file.id} file={file} message={message} />;
      })}
      {message.cards.map((card, index) => {
        const Card = cardComponent(card.type);
        if (Card) return <Card key={index} card={card} message={message} />;
        return KNOWN_CARD_KINDS.has(card.type) ? (
          <CardFallback key={index} card={card} message={message} known />
        ) : (
          <UnknownCard key={index} card={card} message={message} />
        );
      })}
    </div>
  );
}
