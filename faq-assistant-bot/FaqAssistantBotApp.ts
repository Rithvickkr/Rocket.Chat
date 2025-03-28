import {
	IAppAccessors,
	IConfigurationExtend,
	ILogger,
	IRead,
	IModify,
	IHttp,
	IPersistence,
} from '@rocket.chat/apps-engine/definition/accessors';
import { IMessage, IPostMessageSent } from '@rocket.chat/apps-engine/definition/messages';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo, RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { SettingType } from '@rocket.chat/apps-engine/definition/settings';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';

export class FaqDetectionAssistantApp extends App implements IPostMessageSent {
	private processedMessageIds: Set<string> = new Set();
	private isProcessing: boolean = false;
	private lastResponseTime: { [roomId: string]: number } = {};
	private lastProcessedContent: { [roomId: string]: string } = {};
	private faqDatabase: { [category: string]: string } = {};

	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
		console.log('🔄 FAQ Bot initialized');
	}

	public async extendConfiguration(configuration: IConfigurationExtend): Promise<void> {
		await configuration.settings.provideSetting({
			id: 'faq-database-drive-url',
			type: SettingType.STRING,
			packageValue: 'https://drive.google.com/uc?export=download&id=1XXGu7gtwt72LV1sQq2crKw-dkMXteg2h',
			required: false,
			public: false,
			i18nLabel: 'FAQ Database Google Drive URL',
			i18nDescription: 'Direct download URL for your FAQ database JSON file from Google Drive',
		});

		await configuration.settings.provideSetting({
			id: 'together-ai-api-key',
			type: SettingType.STRING,
			packageValue: '',
			required: true,
			public: false,
			i18nLabel: 'Together AI API Key',
			i18nDescription: 'API key for Together AI LLM',
		});

		await configuration.settings.provideSetting({
			id: 'moderator-room-id',
			type: SettingType.STRING,
			packageValue: '',
			required: true,
			public: false,
			i18nLabel: 'Moderator Room ID',
			i18nDescription: 'Room ID where FAQ approvals will be sent (e.g., 67df05d7f24ddbc47620549a)',
		});

		await configuration.settings.provideSetting({
			id: 'cooldown-period',
			type: SettingType.NUMBER,
			packageValue: 30,
			required: true,
			public: false,
			i18nLabel: 'Cooldown Period (seconds)',
			i18nDescription: 'Time in seconds between bot responses in the same room',
		});
	}

	private async loadFaqDatabase(http: IHttp, read: IRead): Promise<void> {
		try {
			const databaseUrl = await read.getEnvironmentReader().getSettings().getValueById('faq-database-drive-url');
			if (!databaseUrl) {
				console.log('ℹ️ No FAQ database URL configured, using defaults');
				this.faqDatabase = {
					'password reset': 'Go to settings > security > reset password.',
					'rocket.chat info': 'Rocket.Chat is an open-source team collaboration platform.',
					'unknown': "I'm not sure about that. Could you rephrase your question?",
				};
				return;
			}

			console.log(`🔄 Fetching FAQ database from: ${databaseUrl}`);
			const response = await http.get(databaseUrl);

			if (response.statusCode !== 200) {
				throw new Error(`Failed to fetch FAQ database. Status code: ${response.statusCode}`);
			}

			this.faqDatabase = JSON.parse(response.content || '{}');
			console.log('✅ FAQ database successfully loaded');
			if (!this.faqDatabase['unknown']) {
				this.faqDatabase['unknown'] = "I'm not sure about that. Could you rephrase your question?";
			}
		} catch (error) {
			console.error(`❌ Error fetching FAQ database: ${error.message}`);
			this.faqDatabase = {
				'password reset': 'Go to settings > security > reset password.',
				'rocket.chat info': 'Rocket.Chat is an open-source team collaboration platform.',
				'unknown': "I'm not sure about that. Could you rephrase your question?",
			};
		}
	}

	private async checkDynamicFaqs(read: IRead, query: string): Promise<{ answer: string; confidence: number } | null> {
		const association = [new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `${this.getID()}_dynamic_faqs`)];
		const dynamicFaqs = await read.getPersistenceReader().readByAssociations(association);

		const inputQuery = query.toLowerCase().trim().split(/\s+/);
		let bestMatch: { answer: any; confidence: number } | null = null;
		let bestScore = 0;

		// Best Matching: Keyword overlap scoring
		for (const faq of dynamicFaqs as any[]) {
			if (faq.status !== 'approved') continue; // Only approved FAQs
			const storedQuery = faq.query.toLowerCase().trim().split(/\s+/);
			const overlap = inputQuery.filter((word) => storedQuery.includes(word)).length;
			const score = overlap / Math.max(inputQuery.length, storedQuery.length); // Simple similarity

			if (score > bestScore && score >= 0.9) {
				// BM threshold: 90%
				bestScore = score;
				bestMatch = { answer: faq.answer, confidence: score };
			}
		}

		if (bestMatch) {
			console.log(`ℹ️ Best Match found for query: "${query}" with score: ${bestScore}`);
			return bestMatch;
		}
		return null;
	}

	private async storeDynamicFaq(persistence: IPersistence, query: string, answer: string, status: string = 'pending'): Promise<void> {
		const association = [new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `${this.getID()}_dynamic_faqs`)];
		const faqData = {
			query,
			answer,
			status, // 'pending' or 'approved'
			createdAt: new Date().toISOString(),
		};
		await persistence.createWithAssociations(faqData, association);
		console.log(`✅ Stored dynamic FAQ: "${query}" -> "${answer}" with status "${status}"`);
	}

	private async refineWithLLM(
		http: IHttp,
		read: IRead,
		query: string,
		persistence: IPersistence,
	): Promise<{ response: string; confidence: number; intent: string }> {
		const apiKey = await read.getEnvironmentReader().getSettings().getValueById('together-ai-api-key');
		if (!apiKey) {
			return { response: this.faqDatabase['unknown'] || 'LLM not configured—ask an admin!', confidence: 0.5, intent: 'technical' };
		}

		const faqContext = Object.entries(this.faqDatabase)
			.map(([q, a]) => `Q: ${q}\nA: ${a}`)
			.join('\n');
		const dynamicFaqs = await read
			.getPersistenceReader()
			.readByAssociations([new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `${this.getID()}_dynamic_faqs`)]);
		const dynamicFaqContext = dynamicFaqs
			.filter((f: any) => f.status === 'approved')
			.map((f: any) => `Q: ${f.query}\nA: ${f.answer}`)
			.join('\n');
		const fullFaqContext = `${faqContext}\n${dynamicFaqContext}`.trim();

		// Advanced CoT Prompt
		const prompt = `
        You are a seasoned Rocket.Chat FAQ maestro, deeply embedded in the platform’s open-source architecture, real-time collaboration tools, and user-centric support ecosystem, armed with extensive knowledge to deliver precise, actionable solutions. Your mission is to resolve "${query}" with unparalleled precision and efficiency, employing a rigorous, multi-step process tailored to Rocket.Chat’s dynamic and feature-rich environment:  
        1. Dissect the user’s intent with surgical precision by analyzing the query’s language, structure, and context—classify it as urgent (e.g., "now," "immediately," or "ASAP" signals a time-critical demand), technical (e.g., "how," "configure," "fix," or "troubleshoot" indicates a procedural or system-specific inquiry), or informational (e.g., "what’s," "why," or "tell me" reflects a need for detailed explanation, feature clarity, or conceptual insight). Scrutinize phrasing nuances, keyword prominence, and implied user goals to fully align with Rocket.Chat’s operational context and user expectations.  
        2. Immerse yourself in this expertly curated Rocket.Chat FAQ repository, a comprehensive and meticulously organized collection of verified answers spanning core functionalities (e.g., messaging, channels, file uploads), advanced configurations (e.g., integrations, user permissions, bot settings), and frequent user challenges (e.g., login failures, notification issues, connectivity glitches):  
        ${fullFaqContext}  
        Search with depth and diligence, systematically cross-referencing the query against Rocket.Chat’s feature landscape and typical user scenarios to pinpoint the most relevant, platform-specific response—ensuring no detail is overlooked in this rich knowledge trove.  
        3. Should the query resist a definitive match after exhaustive exploration, provide a professional and constructive fallback: "This query lacks sufficient detail for a Rocket.Chat-specific resolution—please provide more context for an accurate answer." Limit responses to under 50 words, expertly tailoring the tone to mirror the detected intent—swift and commanding for urgent requests, clear and step-by-step for technical needs, or approachable and illuminating for informational queries—guaranteeing every response resonates with Rocket.Chat’s purpose and user experience.  
        4. Compute a confidence score (0.0-1.0) with analytical rigor based on the response’s fidelity and relevance—assign high marks (e.g., 0.9-1.0) for responses that precisely reflect an FAQ entry or seamlessly integrate with Rocket.Chat’s mechanics and workflows, and adopt a cautious range (e.g., 0.3-0.6) when FAQ coverage gaps or query vagueness introduce uncertainty, maintaining transparency and reliability in the resolution process.  
        
        **Output (JSON)**: {"response": "...", "confidence": float, "intent": "..."}
        `.trim();

		try {
			const response = await http.post('https://api.together.xyz/v1/chat/completions', {
				headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				content: JSON.stringify({
					model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
					messages: [{ role: 'system', content: prompt }],
					max_tokens: 100,
					temperature: 0.5,
				}),
			});

			if (response.statusCode !== 200) {
				throw new Error(`API request failed: ${response.statusCode}`);
			}

			const data = JSON.parse(response.content || '{}');
			if (!data.choices?.[0]?.message?.content) {
				throw new Error('Invalid LLM response format');
			}

			const output = JSON.parse(data.choices[0].message.content.trim());
			if (!output.response || typeof output.confidence !== 'number' || !output.intent) {
				throw new Error('Malformed JSON output');
			}

			const blacklist = ['ctrl+alt+delete', 'reboot', 'format'];
			if (blacklist.some((word) => output.response.toLowerCase().includes(word))) {
				return { response: 'I’m not sure.', confidence: 0.3, intent: 'technical' };
			}

			return {
				response: output.response,
				confidence: Math.min(1.0, Math.max(0.0, parseFloat(output.confidence))),
				intent: output.intent,
			};
		} catch (error) {
			console.error(`❌ LLM Refine Error: ${error.message}`);
			return { response: this.faqDatabase['unknown'] || 'Sorry, couldn’t process that.', confidence: 0.4, intent: 'technical' };
		}
	}

	private async sendMessage(modify: IModify, room: IRoom, sendername: string, text: string): Promise<void> {
		try {
			const msg = modify
				.getCreator()
				.startMessage()
				.setRoom(room)
				.setText(`🤖 **FAQ Bot:** ${sendername ? `@${sendername} ` : ''}${text}`);

			await modify.getCreator().finish(msg);
			console.log(`✅ Bot message sent to room ${room.id}`);
		} catch (error) {
			console.error(`❌ Failed to send message to room ${room.id}: ${error.message}`);
			throw error;
		}
	}

	private async sendAck(modify: IModify, room: IRoom, sendername: string): Promise<void> {
		await this.sendMessage(modify, room, sendername, 'Digging into that for you...');
	}

	private async storePendingResponse(
		persistence: IPersistence,
		messageId: string,
		originalRoomId: string,
		response: string,
		originalText: string,
        sendername: string,
	): Promise<string> {
		const association = [new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, this.getID())];
		const pendingData = {
			originalMessageId: messageId,
			originalRoomId,
            sendername,
			response,
			originalText,
			status: 'pending',
			createdAt: new Date().toISOString(),
		};

		await persistence.createWithAssociations(pendingData, association);
		console.log(`✅ Stored pending response with ID ${messageId}`);
		return messageId;
	}

	private async notifyModerators(
		modify: IModify,
		read: IRead,
		originalMessageId: string,
		originalText: string,
		response: string,
		originalRoomId: string,
		sendername: string,
	): Promise<void> {
		const moderatorRoomId = await read.getEnvironmentReader().getSettings().getValueById('moderator-room-id');
		if (!moderatorRoomId) {
			console.error('❌ Moderator room ID not configured.');
			return;
		}

		const room = await read.getRoomReader().getById(moderatorRoomId);
		if (!room) {
			console.error(`❌ Moderator room ${moderatorRoomId} not found.`);
			return;
		}

		const notificationText = `
 **Moderator Action Required**  
**Pending Approval ID**: ${originalMessageId}  
**user**: "${sendername}"
**User Query**: "${originalText}"  
**Proposed Response**: "${response}"  
**Original Room ID**: ${originalRoomId}  
**Commands**:  
- \`@faq-bot approve ${originalMessageId}\` - Approve and send  
- \`@faq-bot edit ${originalMessageId} "new text"\` - Edit and send  
- \`@faq-bot reject ${originalMessageId}\` - Discard  
        `.trim();

		await this.sendMessage(modify, room, '', notificationText);
		console.log(`✅ Sent approval notification to ${moderatorRoomId}`);
	}

	private async handleModeratorCommand(
		modify: IModify,
		persistence: IPersistence,
		read: IRead,
		text: string,
		room: IRoom,
		sendername: string,
	): Promise<boolean> {
		const lowerText = text.toLowerCase().trim();
		if (!lowerText.startsWith('@faq-bot')) return false;

		const parts = lowerText.split(/\s+/);
		const command = parts[1];
		const originalMessageId = parts[2]?.trim();

		if (command === 'clear-persistence') {
			await this.clearPersistence(persistence, read);
			await this.sendMessage(modify, room, sendername, 'Persistence layer cleared—starting fresh!');
			return true;
		}

		if (!originalMessageId || parts.length < 3) {
			await this.sendMessage(modify, room, sendername, 'Invalid command. Use: `@faq-bot <approve|edit|reject> <id> ["new text"]`');
			return true;
		}

		const association = [new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, this.getID())];
		const pendingResponses = await read.getPersistenceReader().readByAssociations(association);
		const pending = pendingResponses.find((r: any) => {
			console.log(`Checking: r.originalMessageId (${r.originalMessageId}) === originalMessageId (${originalMessageId})`);
			return r.originalMessageId.toLowerCase() === originalMessageId.toLowerCase();
		});

		if (!pending) {
			await this.sendMessage(modify, room, sendername, `No pending response found for ID '${originalMessageId}'.`);
			return true;
		}

		const originalRoom = await read.getRoomReader().getById((pending as any).originalRoomId);
		if (!originalRoom) {
			await this.sendMessage(modify, room, sendername, `Error: Original room ${(pending as any).originalRoomId} not found.`);
			await persistence.remove((pending as any)._id || originalMessageId);
			return true;
		}

		if (command === 'approve') {
			await this.sendMessage(modify, originalRoom, (pending as any).sendername, (pending as any).response);
			await this.storeDynamicFaq(persistence, (pending as any).originalText, (pending as any).response, 'approved');
			await persistence.remove((pending as any)._id || originalMessageId);
			await this.sendMessage(modify, room, sendername, `Approved and sent to ${(pending as any).originalRoomId}. Added to FAQs.`);
			return true;
		} else if (command === 'edit' && parts.length > 3) {
			const newTextMatch = text.match(/"(.+)"/);
			const newText = newTextMatch ? newTextMatch[1] : null;
			if (!newText) {
				await this.sendMessage(modify, room, sendername, `Error: Use format: @faq-bot edit ${originalMessageId} "new text"`);
				return true;
			}
			await this.sendMessage(modify, originalRoom, (pending as any).sendername, newText);
			await this.storeDynamicFaq(persistence, (pending as any).originalText, newText, 'approved');
			await persistence.remove((pending as any)._id || originalMessageId);
			await this.sendMessage(modify, room, sendername, `Edited and sent to ${(pending as any).originalRoomId}. Added to FAQs.`);
			return true;
		} else if (command === 'reject') {
			await persistence.remove((pending as any)._id || originalMessageId);
			await this.sendMessage(modify, room, sendername, `Rejected response for ID ${originalMessageId}.`);
			return true;
		}

		await this.sendMessage(modify, room, sendername, `Unrecognized command '${command}'. Use: approve, edit, reject.`);
		return true;
	}

	private isFaqQuery(text: string, senderId?: string): boolean {
		const lowerText = text.toLowerCase().trim();
		const words = lowerText.split(/\s+/).filter((word) => word.length > 0);

		// Skip bot-related or irrelevant messages
		if (
			senderId === this.getID() ||
			lowerText.includes('action required') ||
			lowerText.includes('pending approval id') ||
			lowerText.includes('no pending response found') ||
			lowerText.includes('digging into that') ||
			lowerText.includes('🤖 **faq bot:**') ||
			lowerText.includes('approved and sent') ||
			lowerText.includes('rejected faq response')
		) {
			return false;
		}

		// Expanded FAQ keywords to catch more relevant terms
		const faqKeywords = [
			'password',
			'reset',
			'refund',
			'policy',
			'support',
			'contact',
			'billing',
			'username',
			'payment',
			'account',
			'delete',
			'recover',
			'authentication',
			'download',
			'app',
			'order',
			'track',
			'subscription',
			'trial',
			'bug',
			'issue',
			'customize',
			'theme',
			'color',
			'profile',
			'settings',
			'channel',
			'message',
			'notification',
			'integration',
			'export',
			'invite',
			'team',
			'emoji',
			'layout',
			'rocket.chat',
			'rocket',
			'chat',
			'help',
			'howto',
			'guide',
			'info',
			'feature',
			'plan',
			'upgrade',
			'downgrade',
			'enable',
			'disable',
			'change',
			'update',
			'create',
			'join',
			'leave',
			'mute',
		];

		// Bot mentions or commands
		const botMention = lowerText.includes('@faq-bot') || lowerText.startsWith('!faq');

		// Expanded question starters and loosened length check
		const questionStarters = [
			'how',
			'what',
			'where',
			'when',
			'why',
			'is',
			'are',
			'can',
			'do',
			'does',
			'will',
			'should',
			'could',
			'would',
			'who',
			'which',
			'tell me',
			'explain',
			'describe',
			'find',
			'search',
			'show me',
			'help me',
			'assist me',
			'clarify',
			'detail',
			'advise',
			"what's",
			'how to',
			'can you',
			'could you',
			'would you',
			'is it possible',
			'are there',
			'do you know',
			'can I',
            'why\'s'
		];
		const isQueryLike =
			lowerText.includes('?') ||
			questionStarters.some((starter) => lowerText.startsWith(starter)) ||
			(words.length >= 2 && words.some((word) => word.length >= 3));

		// Broader logic: keyword OR mention, AND query-like
		const hasKeywordOrMention = faqKeywords.some((keyword) => lowerText.includes(keyword)) || botMention;
		return hasKeywordOrMention && isQueryLike;
	}

	private async clearPersistence(persistence: IPersistence, read: IRead): Promise<void> {
		try {
			const associations = [
				new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, this.getID()),
				new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `${this.getID()}_dynamic_faqs`),
			];

			for (const assoc of associations) {
				const records = await read.getPersistenceReader().readByAssociations([assoc]);
				if (records.length === 0) {
					console.log(` No records found for association: ${(assoc as any).id}`);
					continue;
				}

				for (const record of records as any[]) {
					const recordId = record._id || record.originalMessageId;
					if (recordId) {
						await persistence.remove(recordId);
						console.log(`✅ Removed record with ID: ${recordId} from ${(assoc as any).id}`);
					}
				}
			}
			console.log('✅ Persistence layer cleared successfully');
		} catch (error) {
			console.error(`❌ Error clearing persistence: ${error.message}`);
			throw new Error('Failed to clear persistence layer');
		}
	}

	public async executePostMessageSent(
		message: IMessage,
		read: IRead,
		http: IHttp,
		persistence: IPersistence,
		modify: IModify,
	): Promise<void> {
		try {
			if (message.id && this.processedMessageIds.has(message.id)) {
				console.log(`⏭️ Already processed message ${message.id}`);
				return;
			}
			if (message.id) {
				this.processedMessageIds.add(message.id);
				if (this.processedMessageIds.size > 100) {
					this.processedMessageIds = new Set([...this.processedMessageIds].slice(-100));
				}
			}

			if (message.sender.username === 'faq-assistant-bot' || message.sender.type === 'bot' || message.sender.id === this.getID()) {
				console.log(`⏭️ Skipping bot's own message from ${message.sender.username}`);
				return;
			}

			let oroomId = message.room.id;
			console.log(`Processing message from room ID: ${oroomId}`);
			if (oroomId === 'GENERAL') {
				const generalRoom = await read.getRoomReader().getByName('general');
				if (generalRoom) {
					oroomId = generalRoom.id;
					console.log(` Corrected room ID to ${oroomId}`);
				} else {
					console.error(`❌ Failed to fetch #general room ID`);
					return;
				}
			}

			const text = message.text?.toLowerCase();
			if (!text) {
				console.log('❌ No text found in message.');
				return;
			}

			if (await this.handleModeratorCommand(modify, persistence, read, text, message.room, message.sender.username)) {
				console.log('✅ Moderator command processed');
				return;
			}

			if (this.isProcessing) {
				console.log('⏭️ Already processing a message');
				return;
			}
			this.isProcessing = true;

			const cooldownSetting = (await read.getEnvironmentReader().getSettings().getValueById('cooldown-period')) || 30;
			const cooldownPeriod = cooldownSetting * 1000;
			const currentTime = Date.now();
			if (this.lastResponseTime[oroomId] && currentTime - this.lastResponseTime[oroomId] < cooldownPeriod) {
				console.log('⏭️ Skipping due to cooldown');
				this.isProcessing = false;
				return;
			}

			if (this.lastProcessedContent[oroomId] === text) {
				console.log('⏭️ Skipping duplicate content');
				this.isProcessing = false;
				return;
			}
			this.lastProcessedContent[oroomId] = text;

			if (!this.isFaqQuery(text, message.sender.id)) {
				console.log(`⏭️ Skipping non-FAQ message: "${text}"`);
				this.isProcessing = false;
				return;
			}
			console.log(` FAQ query received: "${text}" from ${message.sender.username}`);

			await this.loadFaqDatabase(http, read); // Load FAQs once per query

			const dynamicMatch = await this.checkDynamicFaqs(read, message.text!);
			if (dynamicMatch) {
				await this.sendMessage(modify, message.room, message.sender.username, dynamicMatch.answer);
				this.lastResponseTime[oroomId] = currentTime;
				this.isProcessing = false;
				return;
			}

			const llmResult = await this.refineWithLLM(http, read, message.text!, persistence);
			const threshold = 0.8; // Fixed LLM threshold

			if (llmResult.confidence >= threshold) {
				const prefix = llmResult.intent === 'urgent' ? '⚡' : llmResult.intent === 'casual' ? '😎' : '';
				await this.sendMessage(modify, message.room, message.sender.username, `${prefix} ${llmResult.response}`);
			} else {
				await this.sendAck(modify, message.room, message.sender.username);
				if (!message.id) throw new Error('Message ID missing for moderation');
				const originalMessageId = await this.storePendingResponse(
					persistence,
					message.id,
					oroomId,
					llmResult.response,
					message.text!,
                    message.sender.username
				);
				await this.notifyModerators(
					modify,
					read,
					originalMessageId,
					message.text!,
					llmResult.response,
					oroomId,
					message.sender.username,
				);
			}
			this.lastResponseTime[oroomId] = currentTime;
		} catch (error) {
			console.error('❌ Error in executePostMessageSent:', error);
		} finally {
			this.isProcessing = false;
		}
	}
}
