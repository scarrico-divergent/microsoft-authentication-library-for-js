/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ICrypto,
    IPerformanceClient,
    JoseHeader,
    Logger,
    PerformanceEvents,
    SignedHttpRequest,
    SignedHttpRequestParameters,
} from "@azure/msal-common";
import { base64Encode, urlEncode, urlEncodeArr } from "../encode/Base64Encode";
import { base64Decode } from "../encode/Base64Decode";
import * as BrowserCrypto from "./BrowserCrypto";
import { BrowserStringUtils } from "../utils/BrowserStringUtils";
import {
    createBrowserAuthError,
    BrowserAuthErrorCodes,
} from "../error/BrowserAuthError";
import { CryptoKeyStore } from "../cache/CryptoKeyStore";

export type CachedKeyPair = {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
    requestMethod?: string;
    requestUri?: string;
};

/**
 * This class implements MSAL's crypto interface, which allows it to perform base64 encoding and decoding, generating cryptographically random GUIDs and
 * implementing Proof Key for Code Exchange specs for the OAuth Authorization Code Flow using PKCE (rfc here: https://tools.ietf.org/html/rfc7636).
 */
export class CryptoOps implements ICrypto {
    private logger: Logger;

    /**
     * CryptoOps can be used in contexts outside a PCA instance,
     * meaning there won't be a performance manager available.
     */
    private performanceClient: IPerformanceClient | undefined;

    private static POP_KEY_USAGES: Array<KeyUsage> = ["sign", "verify"];
    private static EXTRACTABLE: boolean = true;
    private cache: CryptoKeyStore;

    constructor(logger: Logger, performanceClient?: IPerformanceClient) {
        this.logger = logger;
        // Browser crypto needs to be validated first before any other classes can be set.
        BrowserCrypto.validateCryptoAvailable(logger);
        this.cache = new CryptoKeyStore(this.logger);
        this.performanceClient = performanceClient;
    }

    /**
     * Creates a new random GUID - used to populate state and nonce.
     * @returns string (GUID)
     */
    createNewGuid(): string {
        return BrowserCrypto.createNewGuid();
    }

    /**
     * Encodes input string to base64.
     * @param input
     */
    base64Encode(input: string): string {
        return base64Encode(input);
    }

    /**
     * Decodes input string from base64.
     * @param input
     */
    base64Decode(input: string): string {
        return base64Decode(input);
    }

    /**
     * Generates a keypair, stores it and returns a thumbprint
     * @param request
     */
    async getPublicKeyThumbprint(
        request: SignedHttpRequestParameters
    ): Promise<string> {
        const publicKeyThumbMeasurement =
            this.performanceClient?.startMeasurement(
                PerformanceEvents.CryptoOptsGetPublicKeyThumbprint,
                request.correlationId
            );

        // Generate Keypair
        const keyPair: CryptoKeyPair = await BrowserCrypto.generateKeyPair(
            CryptoOps.EXTRACTABLE,
            CryptoOps.POP_KEY_USAGES
        );

        // Generate Thumbprint for Public Key
        const publicKeyJwk: JsonWebKey = await BrowserCrypto.exportJwk(
            keyPair.publicKey
        );

        const pubKeyThumprintObj: JsonWebKey = {
            e: publicKeyJwk.e,
            kty: publicKeyJwk.kty,
            n: publicKeyJwk.n,
        };

        const publicJwkString: string =
            BrowserStringUtils.getSortedObjectString(pubKeyThumprintObj);
        const publicJwkHash = await this.hashString(publicJwkString);

        // Generate Thumbprint for Private Key
        const privateKeyJwk: JsonWebKey = await BrowserCrypto.exportJwk(
            keyPair.privateKey
        );
        // Re-import private key to make it unextractable
        const unextractablePrivateKey: CryptoKey =
            await BrowserCrypto.importJwk(privateKeyJwk, false, ["sign"]);

        // Store Keypair data in keystore
        await this.cache.asymmetricKeys.setItem(publicJwkHash, {
            privateKey: unextractablePrivateKey,
            publicKey: keyPair.publicKey,
            requestMethod: request.resourceRequestMethod,
            requestUri: request.resourceRequestUri,
        });

        if (publicKeyThumbMeasurement) {
            publicKeyThumbMeasurement.end({
                success: true,
            });
        }

        return publicJwkHash;
    }

    /**
     * Removes cryptographic keypair from key store matching the keyId passed in
     * @param kid
     */
    async removeTokenBindingKey(kid: string): Promise<boolean> {
        await this.cache.asymmetricKeys.removeItem(kid);
        const keyFound = await this.cache.asymmetricKeys.containsKey(kid);
        return !keyFound;
    }

    /**
     * Removes all cryptographic keys from IndexedDB storage
     */
    async clearKeystore(): Promise<boolean> {
        return await this.cache.clear();
    }

    /**
     * Signs the given object as a jwt payload with private key retrieved by given kid.
     * @param payload
     * @param kid
     */
    async signJwt(
        payload: SignedHttpRequest,
        kid: string,
        correlationId?: string
    ): Promise<string> {
        const signJwtMeasurement = this.performanceClient?.startMeasurement(
            PerformanceEvents.CryptoOptsSignJwt,
            correlationId
        );
        const cachedKeyPair = await this.cache.asymmetricKeys.getItem(kid);

        if (!cachedKeyPair) {
            throw createBrowserAuthError(
                BrowserAuthErrorCodes.cryptoKeyNotFound
            );
        }

        // Get public key as JWK
        const publicKeyJwk = await BrowserCrypto.exportJwk(
            cachedKeyPair.publicKey
        );
        const publicKeyJwkString =
            BrowserStringUtils.getSortedObjectString(publicKeyJwk);

        // Base64URL encode public key thumbprint with keyId only: BASE64URL({ kid: "FULL_PUBLIC_KEY_HASH" })
        const encodedKeyIdThumbprint = urlEncode(JSON.stringify({ kid: kid }));

        // Generate header
        const shrHeader = JoseHeader.getShrHeaderString({
            kid: encodedKeyIdThumbprint,
            alg: publicKeyJwk.alg,
        });
        const encodedShrHeader = urlEncode(shrHeader);

        // Generate payload
        payload.cnf = {
            jwk: JSON.parse(publicKeyJwkString),
        };
        const encodedPayload = urlEncode(JSON.stringify(payload));

        // Form token string
        const tokenString = `${encodedShrHeader}.${encodedPayload}`;

        // Sign token
        const tokenBuffer = BrowserStringUtils.stringToUtf8Arr(tokenString);
        const signatureBuffer = await BrowserCrypto.sign(
            cachedKeyPair.privateKey,
            tokenBuffer
        );
        const encodedSignature = urlEncodeArr(new Uint8Array(signatureBuffer));

        const signedJwt = `${tokenString}.${encodedSignature}`;

        if (signJwtMeasurement) {
            signJwtMeasurement.end({
                success: true,
            });
        }

        return signedJwt;
    }

    /**
     * Returns the SHA-256 hash of an input string
     * @param plainText
     */
    async hashString(plainText: string): Promise<string> {
        const hashBuffer: ArrayBuffer = await BrowserCrypto.sha256Digest(
            plainText
        );
        const hashBytes = new Uint8Array(hashBuffer);
        return urlEncodeArr(hashBytes);
    }
}
