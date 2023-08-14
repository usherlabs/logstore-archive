import {
	EthereumAddress,
	LogStoreClient,
	MessageMetadata,
	NodeMetadata,
	Stream,
} from '@logsn/client';
import {
	RecoveryComplete,
	RecoveryResponse,
	SystemMessage,
	SystemMessageType,
} from '@logsn/protocol';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { Signer } from 'ethers';
import { Base64 } from 'js-base64';
import { shuffle } from 'lodash';
import { Logger } from 'tslog';

import { Managers } from '../managers';
import { StreamSubscriber } from '../shared/StreamSubscriber';

const LISTENING_MESSAGE_TYPES = [
	SystemMessageType.RecoveryResponse,
	SystemMessageType.RecoveryComplete,
];

interface RecoveryProgress {
	timestamp?: number;
	isComplete: boolean;
}

export class SystemRecovery {
	private requestId: string;
	private subscriber: StreamSubscriber;

	private progresses: Map<EthereumAddress, RecoveryProgress> = new Map();

	constructor(
		private readonly client: LogStoreClient,
		private readonly systemStream: Stream,
		private readonly signer: Signer,
		private readonly logger: Logger,
		private readonly onSystemMessage: (
			systemMessage: SystemMessage,
			metadata: MessageMetadata
		) => Promise<void>
	) {
		this.subscriber = new StreamSubscriber(this.client, this.systemStream);
	}

	public async start() {
		this.logger.info('Starting SystemRecovery ...');

		await this.subscriber.subscribe((content, metadata) =>
			setImmediate(() => this.onMessage(content, metadata))
		);

		const endpoint = `${await this.getBrokerEndpoint()}/recovery`;
		const authUser = await this.client.getAddress();
		const authPassword = await this.signer.signMessage(authUser);

		this.requestId = randomUUID();
		const headers = {
			'Content-Type': 'application/json',
			Authorization: `Basic ${Base64.encode(`${authUser}:${authPassword}`)}`,
		};

		this.logger.debug(
			'Calling recovery enpoint',
			JSON.stringify({
				endpoint,
				requestId: this.requestId,
			})
		);

		const response = await axios.post(
			endpoint,
			{ requestId: this.requestId },
			{ headers }
		);

		const brokerAddresses = response.data as EthereumAddress[];
		for (const brokerAddress of brokerAddresses) {
			this.progresses.set(brokerAddress, { isComplete: false });
		}

		this.logger.debug(
			'Collecting RecoveryResponses from brokers',
			JSON.stringify(brokerAddresses)
		);
	}

	public async stop() {
		await this.subscriber.unsubscribe();
	}

	public get progress(): RecoveryProgress {
		const result: RecoveryProgress = {
			timestamp: Number.MAX_SAFE_INTEGER,
			isComplete: true,
		};

		for (const [_, progress] of this.progresses) {
			if (progress.timestamp === undefined) {
				return { isComplete: false };
			}

			result.timestamp = Math.min(result.timestamp, progress.timestamp);
			result.isComplete = result.isComplete && progress.isComplete;
		}

		return result;
	}

	private async getBrokerEndpoint() {
		const addresses = shuffle(
			await Managers.withSources(async (managers) => {
				return await managers.node.contract.nodeAddresses();
			})
		);

		for (const address of addresses) {
			const node = await Managers.withSources(async (managers) => {
				return await managers.node.contract.nodes(address);
			});

			if (node.metadata.includes('http')) {
				try {
					const metadata = JSON.parse(node.metadata) as NodeMetadata;
					new URL(metadata.http);
					return metadata.http;
				} catch {
					// do nothing
				}
			}
		}

		throw new Error('No available enpoints');
	}

	private async onMessage(
		content: unknown,
		metadata: MessageMetadata
	): Promise<void> {
		const systemMessage = SystemMessage.deserialize(content);
		if (!LISTENING_MESSAGE_TYPES.includes(systemMessage.messageType)) {
			return;
		}

		let progress = this.progresses.get(metadata.publisherId);
		if (!progress) {
			progress = { isComplete: false };
			this.progresses.set(metadata.publisherId, progress);
		}

		switch (systemMessage.messageType) {
			case SystemMessageType.RecoveryResponse: {
				const recoveryResponse = systemMessage as RecoveryResponse;

				if (recoveryResponse.requestId != this.requestId) {
					return;
				}

				this.logger.debug(
					'Processing RecoveryResponse',
					JSON.stringify({
						publisherId: metadata.publisherId,
						payloadLength: recoveryResponse.payload.length,
					})
				);

				for await (const [msg, msgMetadata] of recoveryResponse.payload) {
					await this.onSystemMessage(msg, msgMetadata as MessageMetadata);
					progress.timestamp = metadata.timestamp;
				}

				break;
			}
			case SystemMessageType.RecoveryComplete: {
				const recoveryComplete = systemMessage as RecoveryComplete;

				if (recoveryComplete.requestId != this.requestId) {
					return;
				}

				this.logger.debug(
					'Processing RecoveryComplete',
					JSON.stringify({
						publisherId: metadata.publisherId,
					})
				);

				// if no recovery messages received
				if (progress.timestamp === undefined) {
					progress.timestamp = 0;
				}

				progress.isComplete = true;

				if (this.progress.isComplete) {
					await this.stop();
					this.logger.info('Successfully complete SystemRecovery');
				}
				break;
			}
		}
	}
}
