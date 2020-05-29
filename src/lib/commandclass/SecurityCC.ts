import { randomBytes } from "crypto";
import type { ZWaveController } from "../controller/Controller";
import {
	SendDataRequest,
	TransmitOptions,
} from "../controller/SendDataMessages";
import type { Driver } from "../driver/Driver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import log from "../log";
import type { MessageOrCCLogEntry } from "../log/shared";
import { MessagePriority } from "../message/Constants";
import { parseCCList } from "../node/NodeInfo";
import {
	computeMAC,
	decryptAES128OFB,
	encryptAES128OFB,
} from "../security/crypto";
import {
	generateAuthKey,
	generateEncryptionKey,
	SecurityManager,
} from "../security/Manager";
import { getEnumMemberName, pick, validatePayload } from "../util/misc";
import type { Maybe } from "../values/Primitive";
import { CCAPI } from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	CCResponsePredicate,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";
import { CommandClasses } from "./CommandClasses";

// @noSetValueAPI This is an encapsulation CC

// All the supported commands
export enum SecurityCommand {
	CommandsSupportedGet = 0x02,
	CommandsSupportedReport = 0x03,
	SchemeGet = 0x04,
	SchemeReport = 0x05,
	SchemeInherit = 0x08,
	NetworkKeySet = 0x06,
	NetworkKeyVerify = 0x07,
	NonceGet = 0x40,
	NonceReport = 0x80,
	CommandEncapsulation = 0x81,
	CommandEncapsulationNonceGet = 0xc1,
}

function getAuthenticationData(
	senderNonce: Buffer,
	receiverNonce: Buffer,
	ccCommand: SecurityCommand,
	sendingNodeId: number,
	receivingNodeId: number,
	encryptedPayload: Buffer,
): Buffer {
	return Buffer.concat([
		senderNonce,
		receiverNonce,
		Buffer.from([
			ccCommand,
			sendingNodeId,
			receivingNodeId,
			encryptedPayload.length,
		]),
		encryptedPayload,
	]);
}

const HALF_NONCE_SIZE = 8;

// TODO: Ignore commands if received via multicast

@API(CommandClasses.Security)
export class SecurityCCAPI extends CCAPI {
	public supportsCommand(_cmd: SecurityCommand): Maybe<boolean> {
		// All commands are mandatory
		return true;
	}

	public async sendEncapsulated(
		encapsulated: CommandClass,
		requestNextNonce: boolean = false,
	): Promise<void> {
		if (requestNextNonce) {
			this.assertSupportsCommand(
				SecurityCommand,
				SecurityCommand.CommandEncapsulation,
			);
		} else {
			this.assertSupportsCommand(
				SecurityCommand,
				SecurityCommand.CommandEncapsulationNonceGet,
			);
		}

		const cc = new (requestNextNonce
			? SecurityCCCommandEncapsulationNonceGet
			: SecurityCCCommandEncapsulation)(this.driver, {
			nodeId: this.endpoint.nodeId,
			encapsulated,
		});
		await this.driver.sendCommand(cc);
	}

	public async getNonce(): Promise<Buffer> {
		this.assertSupportsCommand(SecurityCommand, SecurityCommand.NonceGet);

		const cc = new SecurityCCNonceGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<SecurityCCNonceReport>(
			cc,
			{
				// Nonce requests must be handled immediately
				priority: MessagePriority.Handshake,
			},
		))!;
		return response.nonce;
	}

	/** Responds to a NonceGet request. The message is sent without any retransmission etc. */
	public sendNonce(): void {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.NonceReport,
		);

		if (!this.driver.securityManager) {
			throw new ZWaveError(
				`Nonces can only be sent if secure communication is set up!`,
				ZWaveErrorCodes.Driver_NoSecurity,
			);
		}

		const nonce = this.driver.securityManager.generateNonce(
			HALF_NONCE_SIZE,
		);

		const cc = new SecurityCCNonceReport(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			nonce,
		});
		const msg = new SendDataRequest(this.driver, {
			command: cc,
			// Don't want a response from the target node
			transmitOptions: TransmitOptions.DEFAULT & ~TransmitOptions.ACK,
			// Don't want a response from the controller
			callbackId: 0,
		});
		this.driver.sendAndForget(msg);
	}

	public async getSecurityScheme(): Promise<[0]> {
		this.assertSupportsCommand(SecurityCommand, SecurityCommand.SchemeGet);

		const cc = new SecurityCCSchemeGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		await this.driver.sendCommand(cc);
		// There is only one scheme, so we hardcode it
		return [0];
	}

	public async inheritSecurityScheme(): Promise<void> {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.SchemeInherit,
		);

		const cc = new SecurityCCSchemeInherit(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		await this.driver.sendCommand(cc);
		// There is only one scheme, so we don't return anything here
	}

	public async setNetworkKey(networkKey: Buffer): Promise<void> {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.NetworkKeySet,
		);

		const keySet = new SecurityCCNetworkKeySet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			networkKey,
		});
		const cc = new SecurityCCCommandEncapsulation(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			encapsulated: keySet,
			alternativeNetworkKey: Buffer.alloc(16, 0),
		});
		await this.driver.sendCommand(cc);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async getSupportedCommands() {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.CommandsSupportedGet,
		);

		const cc = new SecurityCCCommandsSupportedGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			SecurityCCCommandsSupportedReport
		>(cc))!;
		return pick(response, ["supportedCCs", "controlledCCs"]);
	}
}

@commandClass(CommandClasses.Security)
@implementedVersion(1)
export class SecurityCC extends CommandClass {
	declare ccCommand: SecurityCommand;
	// Force singlecast for the Security CC (for now)
	declare nodeId: number;
	// Define the securityManager and controller.ownNodeId as existing
	declare driver: Driver & {
		securityManager: SecurityManager;
		controller: ZWaveController & {
			ownNodeId: number;
		};
	};

	public async interview(complete: boolean = true): Promise<void> {
		const node = this.getNode()!;
		const endpoint = this.getEndpoint()!;
		const api = endpoint.commandClasses.Security;

		// This only needs to be done once
		if (complete) {
			log.controller.logNode(node.id, {
				message: "querying securely supported commands...",
				direction: "outbound",
			});

			const resp = await api.getSupportedCommands();
			const logLines: string[] = [
				"received secure commands",
				"supported CCs:",
			];
			for (const cc of resp.supportedCCs) {
				logLines.push(`· ${getEnumMemberName(CommandClasses, cc)}`);
			}
			logLines.push("controlled CCs:");
			for (const cc of resp.controlledCCs) {
				logLines.push(`· ${getEnumMemberName(CommandClasses, cc)}`);
			}
			log.controller.logNode(node.id, {
				message: logLines.join("\n"),
				direction: "inbound",
			});

			// Remember which commands are supported securely
			for (const cc of resp.supportedCCs) {
				endpoint.addCC(cc, {
					isSupported: true,
					secure: true,
				});
			}
			for (const cc of resp.controlledCCs) {
				endpoint.addCC(cc, {
					isControlled: true,
					secure: true,
				});
			}

			// Remember that the interview is complete
			this.interviewComplete = true;
		}
	}

	/** Tests if a should be sent secure and thus requires encapsulation */
	public static requiresEncapsulation(cc: CommandClass): boolean {
		return (
			cc.secure &&
			// Already encapsulated (SecurityCCCommandEncapsulationNonceGet is a subclass)
			!(cc instanceof SecurityCCCommandEncapsulation) &&
			// Cannot be sent encapsulated
			!(cc instanceof SecurityCCNonceGet) &&
			!(cc instanceof SecurityCCNonceReport) &&
			!(cc instanceof SecurityCCSchemeGet) &&
			!(cc instanceof SecurityCCSchemeReport)
		);
	}

	/** Encapsulates a command that should be sent encrypted */
	public static encapsulate(
		driver: Driver,
		cc: CommandClass,
	): SecurityCCCommandEncapsulation {
		// TODO: When to return a SecurityCCCommandEncapsulationNonceGet?
		return new SecurityCCCommandEncapsulation(driver, {
			nodeId: cc.nodeId,
			encapsulated: cc,
		});
	}

	/** Unwraps a security encapsulated command */
	public static unwrap(cc: SecurityCCCommandEncapsulation): CommandClass {
		return cc.encapsulated;
	}
}

interface SecurityCCNonceReportOptions extends CCCommandOptions {
	nonce: Buffer;
}

@CCCommand(SecurityCommand.NonceReport)
export class SecurityCCNonceReport extends SecurityCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| SecurityCCNonceReportOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length === HALF_NONCE_SIZE);
			this.nonce = this.payload;
		} else {
			if (options.nonce.length !== HALF_NONCE_SIZE) {
				throw new ZWaveError(
					`Nonce must have length ${HALF_NONCE_SIZE}!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.nonce = options.nonce;
		}
	}

	public nonce: Buffer;

	public serialize(): Buffer {
		this.payload = this.nonce;
		return super.serialize();
	}
}

@CCCommand(SecurityCommand.NonceGet)
@expectedCCResponse(SecurityCCNonceReport)
export class SecurityCCNonceGet extends SecurityCC {}

const testResponseForCommandEncapsulation: CCResponsePredicate<SecurityCCCommandEncapsulation> = (
	sent,
	received,
	isPositiveTransmitReport,
) => {
	return received instanceof SecurityCCCommandEncapsulation ||
		isPositiveTransmitReport
		? "checkEncapsulated"
		: "unexpected";
};

interface SecurityCCCommandEncapsulationOptions extends CCCommandOptions {
	encapsulated: CommandClass;
	alternativeNetworkKey?: Buffer;
}

@CCCommand(SecurityCommand.CommandEncapsulation)
@expectedCCResponse(testResponseForCommandEncapsulation)
export class SecurityCCCommandEncapsulation extends SecurityCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| SecurityCCCommandEncapsulationOptions,
	) {
		super(driver, options);

		if (!(this.driver.controller.ownNodeId as unknown)) {
			throw new ZWaveError(
				`Secure commands can can only be sent when the controller's node id is known!`,
				ZWaveErrorCodes.Driver_NotReady,
			);
		} else if (!(this.driver.securityManager as unknown)) {
			throw new ZWaveError(
				`Secure commands can only be sent when the network key for the driver is set`,
				ZWaveErrorCodes.Driver_NoSecurity,
			);
		}

		if (gotDeserializationOptions(options)) {
			// HALF_NONCE_SIZE bytes iv, 1 byte frame control, 2 bytes CC header, 1 byte nonce id, 8 bytes auth code
			validatePayload(
				this.payload.length >= HALF_NONCE_SIZE + 1 + 2 + 1 + 8,
			);
			const iv = this.payload.slice(0, HALF_NONCE_SIZE);
			// TODO: frame control
			const encryptedPayload = this.payload.slice(HALF_NONCE_SIZE, -9);
			const nonceId = this.payload[this.payload.length - 9];
			const authCode = this.payload.slice(-8);

			// Retrieve the used nonce from the nonce store
			const nonce = this.driver.securityManager.getNonce(nonceId);
			// Only accept the message if the nonce hasn't expired
			validatePayload(!!nonce);
			// TODO: mark nonce as used

			this.authKey = this.driver.securityManager.authKey;
			this.encryptionKey = this.driver.securityManager.encryptionKey;

			// Validate the encrypted data
			const authData = getAuthenticationData(
				iv,
				nonce!,
				this.ccCommand,
				this.nodeId,
				this.driver.controller.ownNodeId,
				encryptedPayload,
			);
			const expectedAuthCode = computeMAC(authData, this.authKey);
			// Only accept messages with a correct auth code
			validatePayload(authCode.equals(expectedAuthCode));

			// Decrypt the encapsulated CC
			const frameControlAndDecryptedCC = decryptAES128OFB(
				encryptedPayload,
				this.encryptionKey,
				Buffer.concat([iv, nonce!]),
			);
			// TODO: const frameControl = frameControlAndDecryptedCC[0];
			const decryptedCC = frameControlAndDecryptedCC.slice(1);
			this.encapsulated = CommandClass.from(this.driver, {
				data: decryptedCC,
				fromEncapsulation: true,
				encapCC: this,
			});
		} else {
			this.encapsulated = options.encapsulated;
			if (options.alternativeNetworkKey) {
				this.authKey = generateAuthKey(options.alternativeNetworkKey);
				this.encryptionKey = generateEncryptionKey(
					options.alternativeNetworkKey,
				);
			} else {
				this.authKey = this.driver.securityManager.authKey;
				this.encryptionKey = this.driver.securityManager.encryptionKey;
			}
		}
	}

	public encapsulated: CommandClass;
	private authKey: Buffer;
	private encryptionKey: Buffer;

	public nonceId: number | undefined;
	private handshakeFailed: boolean = false;

	public requiresPreTransmitHandshake(): boolean {
		return this.nonceId == undefined;
	}

	public preTransmitHandshake(): boolean | Promise<boolean> {
		// We only get one chance at a security handshake
		if (this.handshakeFailed) return false;

		// wotan-disable-next-line async-function-assignability
		return new Promise<boolean>(async (resolve, reject) => {
			// Request new nonce and store it
			let nonce: Buffer;
			try {
				nonce = await this.getNode()!.commandClasses.Security.getNonce();
			} catch (e) {
				// If requesting a nonce failed, fail the handshake
				if (
					e instanceof ZWaveError &&
					(e.code === ZWaveErrorCodes.Controller_NodeTimeout ||
						e.code === ZWaveErrorCodes.Controller_MessageDropped)
				) {
					// Remember that the handshake failed, so no further attempt is done
					this.handshakeFailed = false;
					resolve(false);
					return;
				}
				reject(e);
				return;
			}
			const secMan = this.driver.securityManager;
			this.nonceId = secMan.getNonceId(nonce);
			secMan.setNonce(
				{
					nodeId: this.nodeId,
					nonceId: this.nonceId,
				},
				nonce,
			);
			resolve(true);
		});
	}

	public serialize(): Buffer {
		function throwNoNonce(): never {
			throw new ZWaveError(
				`Security CC requires a nonce to be sent!`,
				ZWaveErrorCodes.SecurityCC_NoNonce,
			);
		}

		// Try to find an active nonce
		if (this.nonceId == undefined) throwNoNonce();
		const receiverNonce = this.driver.securityManager.getNonce({
			nodeId: this.nodeId,
			nonceId: this.nonceId,
		});
		if (!receiverNonce) throwNoNonce();

		const serializedCC = this.encapsulated.serialize();
		const plaintext = Buffer.concat([
			Buffer.from([0]), // TODO: frame control
			serializedCC,
		]);
		// Encrypt the payload
		const senderNonce = randomBytes(HALF_NONCE_SIZE);
		const iv = Buffer.concat([senderNonce, receiverNonce]);
		const ciphertext = encryptAES128OFB(plaintext, this.encryptionKey, iv);
		// And generate the auth code
		const authData = getAuthenticationData(
			senderNonce,
			receiverNonce,
			this.ccCommand,
			this.driver.controller.ownNodeId,
			this.nodeId,
			ciphertext,
		);
		const authCode = computeMAC(authData, this.authKey);

		this.payload = Buffer.concat([
			senderNonce,
			ciphertext,
			Buffer.from([this.nonceId]),
			authCode,
		]);
		return super.serialize();
	}
}

// This is the same message, but with another CC command
@CCCommand(SecurityCommand.CommandEncapsulationNonceGet)
export class SecurityCCCommandEncapsulationNonceGet extends SecurityCCCommandEncapsulation {}

@CCCommand(SecurityCommand.SchemeReport)
export class SecurityCCSchemeReport extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(
			this.payload.length >= 1,
			// Since it is unlikely that any more schemes will be added to S0, we hardcode the default scheme here (bit 0 = 0)
			(this.payload[0] & 0b1) === 0,
		);
	}
}

@CCCommand(SecurityCommand.SchemeGet)
@expectedCCResponse(SecurityCCSchemeReport)
export class SecurityCCSchemeGet extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
		// Don't care, we won't get sent this and we have no options
	}

	public serialize(): Buffer {
		// Since it is unlikely that any more schemes will be added to S0, we hardcode the default scheme here (bit 0 = 0)
		this.payload = Buffer.from([0]);
		return super.serialize();
	}
}

@CCCommand(SecurityCommand.SchemeInherit)
@expectedCCResponse(SecurityCCSchemeReport)
export class SecurityCCSchemeInherit extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
		// Don't care, we won't get sent this and we have no options
	}

	public serialize(): Buffer {
		// Since it is unlikely that any more schemes will be added to S0, we hardcode the default scheme here (bit 0 = 0)
		this.payload = Buffer.from([0]);
		return super.serialize();
	}
}

@CCCommand(SecurityCommand.NetworkKeyVerify)
export class SecurityCCNetworkKeyVerify extends SecurityCC {}

interface SecurityCCNetworkKeySetOptions extends CCCommandOptions {
	networkKey: Buffer;
}

@CCCommand(SecurityCommand.NetworkKeySet)
@expectedCCResponse(SecurityCCNetworkKeyVerify)
export class SecurityCCNetworkKeySet extends SecurityCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| SecurityCCNetworkKeySetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			if (options.networkKey.length !== 16) {
				throw new ZWaveError(
					`The network key must have length 16!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.networkKey = options.networkKey;
		}
	}

	public networkKey: Buffer;

	public serialize(): Buffer {
		this.payload = this.networkKey;
		return super.serialize();
	}
}

@CCCommand(SecurityCommand.CommandsSupportedReport)
export class SecurityCCCommandsSupportedReport extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		this.reportsToFollow = this.payload[0];
		const list = parseCCList(this.payload.slice(1));
		this._supportedCCs = list.supportedCCs;
		this._controlledCCs = list.controlledCCs;
	}

	public readonly reportsToFollow: number;

	public expectMoreMessages(): boolean {
		return this.reportsToFollow > 0;
	}

	private _supportedCCs: CommandClasses[];
	public get supportedCCs(): CommandClasses[] {
		return this._supportedCCs;
	}

	private _controlledCCs: CommandClasses[];
	public get controlledCCs(): CommandClasses[] {
		return this._controlledCCs;
	}

	public mergePartialCCs(
		partials: SecurityCCCommandsSupportedReport[],
	): void {
		// Concat the lists of CCs
		this._supportedCCs = [...partials, this]
			.map((report) => report._supportedCCs)
			.reduce((prev, cur) => prev.concat(...cur), []);
		this._controlledCCs = [...partials, this]
			.map((report) => report._controlledCCs)
			.reduce((prev, cur) => prev.concat(...cur), []);
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: `reportsToFollow: ${this.reportsToFollow}
supportedCCs: ${this._supportedCCs
				.map((cc) => getEnumMemberName(CommandClasses, cc))
				.map((cc) => `\n· ${cc}`)
				.join("")}
controlledCCs: ${this._controlledCCs
				.map((cc) => getEnumMemberName(CommandClasses, cc))
				.map((cc) => `\n· ${cc}`)
				.join("")}`,
		};
	}
}

@CCCommand(SecurityCommand.CommandsSupportedGet)
@expectedCCResponse(SecurityCCCommandsSupportedReport)
export class SecurityCCCommandsSupportedGet extends SecurityCC {}
