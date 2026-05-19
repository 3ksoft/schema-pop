import { scope } from "arktype";
import { binary } from "@schema-pop/schema";

// Text-heavy fixture: a chat batch of 4 messages. ts:codec uses fixed-size
// string slots (4-byte length prefix + maxLength bytes), so it's expected
// to lose on payload size against JSON / msgpackr but possibly still win
// on speed.
export const benchSchemaText = scope({
	...binary.import(),
	Message: {
		sender: "string<32",
		body: "string<256",
		timestamp: "u32",
		flags: "u8",
	},
	ChatBatch: {
		batchId: "u32",
		messages: "Message[] == 4",
	},
});

export const TEXT_ROOT_TYPE = "ChatBatch";

export interface MessageLit {
	sender: string;
	body: string;
	timestamp: number;
	flags: number;
}
export interface ChatBatchLit {
	batchId: number;
	messages: MessageLit[];
}

const lorem =
	"Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";
const senders = [
	"alice",
	"bob",
	"carol",
	"dave",
	"eve",
	"frank",
	"grace",
	"heidi",
];

export function makeTextFixture(seed = 1): ChatBatchLit {
	let s = seed >>> 0;
	const rand = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
	const message = (i: number): MessageLit => {
		const bodyLen = 40 + Math.floor(rand() * 80);
		return {
			sender: senders[Math.floor(rand() * senders.length)]!,
			body: lorem.slice(0, bodyLen),
			timestamp: 1700000000 + i * 60,
			flags: Math.floor(rand() * 16),
		};
	};
	return {
		batchId: Math.floor(rand() * 1_000_000),
		messages: Array.from({ length: 4 }, (_, i) => message(i)),
	};
}
