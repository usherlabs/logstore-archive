import { sha256 } from '@kyvejs/protocol';
import {
	IReportV1,
	ReportSerializerVersions,
	SystemMessageType,
	SystemReport,
} from '@logsn/protocol';
import { BigNumber } from 'ethers';

import { Managers } from '../managers';
import { IBrokerNode } from '../types';
import { Arweave } from '../utils/arweave';
import { fetchQueryResponseConsensus } from '../utils/helpers';
import { StakeToken } from '../utils/stake-token';
import { AbstractDataItem } from './abstract';

interface IPrepared {
	fromKey: number;
	toKey: number;
	blockNumber: number;
	stakeToken: StakeToken;
	brokerNodes: IBrokerNode[];
}

export class Report extends AbstractDataItem<IPrepared> {
	prepared: IPrepared;

	override async load(managers: Managers) {
		const { core, fromKey: fromKeyStr, toKey: toKeyStr } = this;
		const fromKey = parseInt(fromKeyStr, 10);
		const toKey = parseInt(toKeyStr, 10);
		core.logger.debug('Report Range: ', { fromKey, toKey });

		if (toKey === 0) {
			return {
				fromKey: 0,
				toKey: 0,
				blockNumber: 0,
				stakeToken: undefined,
				brokerNodes: [],
			};
		}

		// Get all state from Smart Contract up to the current key (where key = block at a timestamp)
		// We do this by using the key (timestamp) to determine the most relevant block
		// ? We need to get the closest block because it may not be the most recent block...
		core.logger.debug('getBlockByTime...');
		const blockNumber = await this.runtime.time.find(toKey);
		core.logger.debug('Block Number: ', {
			blockNumber,
		});

		// Now that we have the block that most closely resemble the current key
		const stakeToken = await managers.node.getStakeToken(blockNumber);
		// Produce brokerNode list by starting at headNode and iterating over nodes.
		const brokerNodes = await managers.node.getBrokerNodes(
			blockNumber,
			stakeToken.minRequirement
		);
		core.logger.debug('Broker Nodes: ', brokerNodes);

		return {
			fromKey,
			toKey,
			blockNumber,
			stakeToken,
			brokerNodes,
		};
	}

	private sort(source: IReportV1): IReportV1 {
		const result: IReportV1 = {
			...source,
			nodes: {},
			delegates: {},
			streams: source.streams.sort((a, b) => a.id.localeCompare(b.id)),
			consumers: source.consumers.sort((a, b) => a.id.localeCompare(b.id)),
			events: {
				queries: source.events.queries.sort((a, b) =>
					a.hash.localeCompare(b.hash)
				),
				storage: source.events.storage.sort((a, b) =>
					a.hash.localeCompare(b.hash)
				),
			},
		};

		const nodeKeys = Object.keys(source.nodes).sort((a, b) =>
			a.localeCompare(b)
		);
		for (const key of nodeKeys) {
			result.nodes[key] = source.nodes[key];
		}

		const delegateKeys = Object.keys(source.delegates).sort((a, b) =>
			a.localeCompare(b)
		);
		for (const key of delegateKeys) {
			result.delegates[key] = source.delegates[key];
		}

		return result;
	}

	public async generate(): Promise<SystemReport> {
		const { fromKey, toKey, blockNumber, brokerNodes, stakeToken } =
			this.prepared;

		const {
			core,
			runtime: { listener },
			toKey: keyStr,
			config: { fees },
		} = this;

		const fromKeyMs = fromKey * 1000;
		const toKeyMs = toKey * 1000;

		// Establish the report
		const report: IReportV1 = {
			s: false,
			v: ReportSerializerVersions.V1,
			id: keyStr,
			height: blockNumber,
			treasury: BigNumber.from(0),
			streams: [],
			consumers: [],
			nodes: {},
			delegates: {},
			events: {
				queries: [],
				storage: [],
			},
		};

		if (keyStr === '0') {
			return new SystemReport(report, ReportSerializerVersions.V1);
		}

		// ------------ SETUP UTILS ------------
		// This method works by distributing a total captured fee amount to a set of nodes.
		// The report yields a difference in node's balance (positive or negative) to apply to the balance on-chain
		// ie. If the report indicates a node value is X, then increment the balance by X, otherwise if value is -Y, then decrement the balance by Y
		const rewardNodes = (
			amount: BigNumber,
			recipients: string[],
			penalise: boolean
		) => {
			// ? All nodes managing all streams right now
			// -- In the future, we would determine the Broker Sub-network relevant to the stream

			const amountPerNode = amount.div(brokerNodes.length);
			const bystanders = brokerNodes
				.map((b) => b.id)
				.filter((id) => !recipients.includes(id));
			let rewardPerRecipient = BigNumber.from(0);
			if (penalise) {
				// base reward per node + rewards deducted from bystanders shared between recipients
				rewardPerRecipient = amountPerNode.add(
					amountPerNode.mul(bystanders.length).div(recipients.length)
				);
			} else {
				rewardPerRecipient = amount.div(recipients.length);
			}

			for (let j = 0; j < brokerNodes.length; j++) {
				const bNode = brokerNodes[j];

				if (typeof report.nodes[bNode.id] !== 'number') {
					report.nodes[bNode.id] = BigNumber.from(0);
				}

				// Add change in balance to node stake
				let balanceDifference = BigNumber.from(0);
				if (recipients.includes(bNode.id)) {
					balanceDifference = rewardPerRecipient;
				} else if (penalise && bystanders.includes(bNode.id)) {
					balanceDifference = amountPerNode.mul(-1);
				}
				report.nodes[bNode.id] = report.nodes[bNode.id].add(balanceDifference);

				// Distributed incremented fee across delegates of node proportional to their stake distribution
				const delegates = Object.entries(bNode.delegates);
				for (let l = 0; l < delegates.length; l++) {
					const [delegateAddr, delegateAmount] = delegates[l];
					const delegatePortion = delegateAmount.div(bNode.stake);
					if (typeof report.delegates[delegateAddr] === 'undefined') {
						report.delegates[delegateAddr] = {};
					}
					if (typeof report.delegates[delegateAddr][bNode.id] !== 'number') {
						report.delegates[delegateAddr][bNode.id] = BigNumber.from(0);
					}
					report.delegates[delegateAddr][bNode.id] = report.delegates[
						delegateAddr
					][bNode.id].add(balanceDifference.mul(delegatePortion));
				}
			}
		};
		// ------------------------------------

		// ------------ STORAGE ------------
		// Use events in the listener cache to determine which events are valid.
		const storeCache = listener.storeDb();
		// a mapping of "contentHash => [[timestamp, valueIndex], [timestamp, valueIndex]]"
		// With this mapping, we can determine which events in the storeCache pertain to the ProofOfMessageStored hash - and therefore which publishers/brokers contributed.
		const storeHashKeyMap: Record<string, [number, number][]> = {};
		const storeCachedItems = storeCache.getRange({
			start: fromKeyMs,
			end: toKeyMs,
		});
		// TODO: We may need to create a special cache for streamIds that are complete dropped during a given item cycle.
		for (const { key: cacheKey, value: cacheValue } of storeCachedItems) {
			if (!cacheValue) continue;
			for (let i = 0; i < cacheValue.length; i++) {
				const value = cacheValue[i];

				const { content, metadata } = value;
				if (!(content && metadata)) {
					continue;
				}

				// verify that the publisher is also a broker node
				// -- despite access management being handled within the Smart Contracts, it's wise to validate here too
				const brokerNode = brokerNodes.find(
					(n) => n.id.toLowerCase() === metadata.publisherId.toLowerCase()
				);
				if (typeof brokerNode === 'undefined') {
					continue;
				}

				if (content?.messageType === SystemMessageType.ProofOfMessageStored) {
					// * The content should be the same for all ProofOfStoredMessage messages received, for a given stored message.
					// We use a hash to consolidate the messages received, whereby the value references the list of single events received each broker on the broker network
					const h = sha256(Buffer.from(JSON.stringify(content)));
					if (!storeHashKeyMap[h]) {
						storeHashKeyMap[h] = [];
					}
					// The key here will referece a specific event within the store cache using the key/index
					storeHashKeyMap[h].push([cacheKey, i]);
				}
			}
		}
		core.logger.debug('Storage HashKeyMap: ', storeHashKeyMap);

		// Apply valid storage events to report
		const streamsMap: Record<
			string,
			{ bytes: number; contributors: string[] }
		> = {};
		const storeHashKeyMapEntries = Object.entries(storeHashKeyMap);
		for (let i = 0; i < storeHashKeyMapEntries.length; i++) {
			const [, storeKeys] = storeHashKeyMapEntries[i];
			// use only messages which have been processed(stored) by at least half the broker nodes
			if (storeKeys.length < brokerNodes.length / 2) {
				continue;
			}

			// Add consolidated events to report
			// ? Fees are determined after the report has been populated by the event data
			const contributingPublishers = [];
			for (let j = 0; j < storeKeys.length; j++) {
				const [cacheKey, valueIndex] = storeKeys[j];
				const cacheValues = storeCache.get(cacheKey);
				const event = cacheValues[valueIndex];
				if (!event) continue;

				// Now, we're iterating over each specific proofOfMessageStored event published by each Broker on the Broker Network

				contributingPublishers.push(event.metadata.publisherId);
				// Stream ID is included in the system stream message.
				const { streamId: id, size, hash } = event.content;
				report.events.storage.push({
					id,
					hash,
					size,
				});

				if (typeof streamsMap[id] === 'undefined') {
					streamsMap[id] = {
						bytes: size,
						contributors: [event.metadata.publisherId],
					};
				} else {
					streamsMap[id].bytes += size;
					if (
						!streamsMap[id].contributors.includes(event.metadata.publisherId)
					) {
						streamsMap[id].contributors.push(event.metadata.publisherId);
					}
				}
			}
		}

		core.logger.debug('Storage Streams Map: ', streamsMap);

		const streamsMapEntries = Object.entries(streamsMap);

		// Determine the Storage Fee per Byte
		const totalBytesStored = streamsMapEntries.reduce((totalBytes, curr) => {
			const [, { bytes }] = curr;
			totalBytes += bytes;
			return totalBytes;
		}, 0);
		let expense = BigNumber.from(0);
		let expensePerByteStored = BigNumber.from(0);
		if (totalBytesStored > 0) {
			expense = BigNumber.from(
				await Arweave.getPrice(totalBytesStored, toKeyMs)
			);
			expensePerByteStored = expense.div(totalBytesStored);
		}
		const writeFee = expensePerByteStored.mul(fees.writeMultiplier);
		const writeTreasuryFee = writeFee
			.sub(expensePerByteStored)
			.mul(fees.treasuryMultiplier); // multiplier on the margin
		const writeNodeFee = writeFee.sub(writeTreasuryFee);

		// Hydrate the report with storage data
		for (let i = 0; i < streamsMapEntries.length; i++) {
			const [streamId, { bytes, contributors }] = streamsMapEntries[i];

			const capture = writeFee.mul(bytes);
			report.streams.push({
				id: streamId,
				capture,
				bytes,
			});
			report.treasury = report.treasury.add(writeTreasuryFee.mul(bytes));

			// Deduct from Node based on the bytes missed.
			// Use identification of publishers that validly contributed storage events to determine if current broker node was apart of that cohort.
			rewardNodes(writeNodeFee.mul(bytes), contributors, true);
		}
		// ------------ END STORAGE ------------
		// -------------------------------------

		// ------------ QUERIES ----------------
		const queryRequestCache = listener.queryRequestDb();
		const queryResponseCache = listener.queryResponseDb();
		// Iterate over the query-request events between the range
		const queryRequestCachedItems = queryRequestCache.getRange({
			start: fromKeyMs,
			end: toKeyMs,
		});

		// Determine read fees
		let readFee = BigNumber.from(0);
		if (totalBytesStored > 0) {
			readFee = writeFee.mul(fees.readMultiplier);
		}
		const readTreasuryFee = readFee.mul(fees.treasuryMultiplier);
		const readNodeFee = readFee.sub(readTreasuryFee);

		for (const { value: cacheValue } of queryRequestCachedItems) {
			if (!cacheValue) continue;
			for (let i = 0; i < cacheValue.length; i++) {
				// Here, we iterate over the query requests that may have occured during the same timestamp
				const value = cacheValue[i];

				const { content, metadata } = value;
				if (!(content && metadata)) {
					continue;
				}

				const queryResponsesForRequest = queryResponseCache.get(
					content.requestId
				);
				const {
					// maxCount: consensusCount,
					maxHash: consensusHash,
					result: queryResponseHashMap,
				} = fetchQueryResponseConsensus(queryResponsesForRequest);

				// get data for response that has the highest consensus
				//  -- In the future, we can penalise nodes for not meeting a threshold of >=50% of the responses

				// get the first item because they should all be the same as they have the same hash
				// and we have confirmed that the length is greater than one so an item will be present
				const { hash, size } = queryResponseHashMap[consensusHash][0].content;

				report.events.queries.push({
					id: content.streamId,
					query: content.queryOptions,
					consumer: content.consumerId,
					hash,
					size,
				});
				const captureAmount = readFee.mul(size);
				const existingConsumerIndex = report.consumers.findIndex(
					(c) => c.id === content.consumerId
				);
				if (existingConsumerIndex < 0) {
					report.consumers.push({
						id: content.consumerId,
						capture: captureAmount, // the total amount of stake to capture token in wei based on the calculations
						bytes: size,
					});
				} else {
					report.consumers[existingConsumerIndex].capture =
						report.consumers[existingConsumerIndex].capture.add(captureAmount);
					report.consumers[existingConsumerIndex].bytes += size;
				}
				report.treasury = report.treasury.add(readTreasuryFee.mul(size));

				// Only apply fees to nodes that have contributed to the conensus response
				const contributors = queryResponseHashMap[consensusHash].map(
					(msg) => msg.metadata.publisherId
				);
				rewardNodes(readNodeFee.mul(size), contributors, false);
			}
		}
		// ------------ END QUERIES ------------
		// -------------------------------------

		// ------------ FEE CONVERSION ------------
		// Convert fees to stake token
		for (const stream of report.streams) {
			report.streams.push({
				id: stream.id,
				capture: await stakeToken.fromUSD(stream.capture.toNumber(), toKeyMs),
				bytes: stream.bytes,
			});
		}
		for (const consumer of report.consumers) {
			report.consumers.push({
				id: consumer.id,
				capture: await stakeToken.fromUSD(consumer.capture.toNumber(), toKeyMs),
				bytes: consumer.bytes,
			});
		}
		for (const nodeKey of Object.keys(report.nodes)) {
			report.nodes[nodeKey] = await stakeToken.fromUSD(
				report.nodes[nodeKey].toNumber(),
				toKeyMs
			);
		}
		for (const delegateKey of Object.keys(report.delegates)) {
			report.delegates[delegateKey] = {};
			for (const nodeKey of Object.keys(report.delegates[delegateKey])) {
				report.delegates[delegateKey][nodeKey] = await stakeToken.fromUSD(
					report.delegates[delegateKey][nodeKey].toNumber(),
					toKeyMs
				);
			}
		}

		report.treasury = await stakeToken.fromUSD(
			report.treasury.toNumber(),
			toKeyMs
		);
		// ------------ END FEE CONVERSION ------------
		// -------------------------------------

		const sortedReport = this.sort(report);

		core.logger.debug('Report Generated', sortedReport);

		const systemReport = new SystemReport(
			sortedReport,
			ReportSerializerVersions.V1
		);

		return systemReport;
	}
}
