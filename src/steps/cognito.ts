import { StepRunner, Store } from '../lib/runner'
import { regexMatcher } from '../lib/regexMatcher'
import { CognitoIdentity, CognitoIdentityServiceProvider } from 'aws-sdk'

const randSeq = () =>
	Math.random()
		.toString(36)
		.replace(/[^a-z]+/g, '')

export type CognitoStepRunnerStore = Store & {
	userPoolId: string
	identityPoolId: string
	userPoolClientId: string
	region: string
}

/**
 * BDD steps for authenticating against AWS Cognito
 */
export const cognitoStepRunners = <W extends CognitoStepRunnerStore>({
	region,
	developerProviderName,
	emailAsUsername,
}: {
	developerProviderName: string
	region: string
	emailAsUsername?: boolean
}): StepRunner<W>[] => {
	const ci = new CognitoIdentity({
		region,
	})
	const cisp = new CognitoIdentityServiceProvider({
		region,
	})
	return [
		{
			willRun: regexMatcher(
				/^I am authenticated with Cognito(?: as "([^"]+)")?$/,
			),
			run: async ([userId], __, runner) => {
				const prefix = userId ? `cognito:${userId}` : `cognito`
				if (!runner.store[`${prefix}:IdentityId`]) {
					const Username = userId ? `${userId}-${randSeq()}` : randSeq()
					const email = `${Username.toLowerCase()}@example.com`
					const cognitoUsername = emailAsUsername ? email : Username
					await runner.progress(
						'Cognito',
						`Registering user ${cognitoUsername}`,
					)
					const TemporaryPassword = `${randSeq()}${randSeq().toUpperCase()}${Math.random()}`
					await cisp
						.adminCreateUser({
							UserPoolId: runner.world.userPoolId,
							Username: cognitoUsername,
							UserAttributes: [
								{
									Name: 'email',
									Value: email,
								},
								{
									Name: 'email_verified',
									Value: 'True',
								},
							],
							TemporaryPassword,
						})
						.promise()

					const newPassword = `${randSeq()}${randSeq().toUpperCase()}${Math.random()}`
					const { Session } = await cisp
						.adminInitiateAuth({
							AuthFlow: 'ADMIN_NO_SRP_AUTH',
							UserPoolId: runner.world.userPoolId,
							ClientId: runner.world.userPoolClientId,
							AuthParameters: {
								USERNAME: cognitoUsername,
								PASSWORD: TemporaryPassword,
							},
						})
						.promise()

					const { AuthenticationResult } = await cisp
						.adminRespondToAuthChallenge({
							ChallengeName: 'NEW_PASSWORD_REQUIRED',
							UserPoolId: runner.world.userPoolId,
							ClientId: runner.world.userPoolClientId,
							Session: Session!,
							ChallengeResponses: {
								USERNAME: cognitoUsername,
								NEW_PASSWORD: newPassword,
							},
						})
						.promise()

					runner.store[`${prefix}:IdToken`] = AuthenticationResult!.IdToken

					runner.store[`${prefix}:Username`] = cognitoUsername
					runner.store[userId ? `${userId}:Email` : 'Email'] = email

					const { IdentityId, Token } = await ci
						.getOpenIdTokenForDeveloperIdentity({
							IdentityPoolId: runner.world.identityPoolId,
							Logins: {
								[developerProviderName]: runner.store[`${prefix}:Username`],
							},
							TokenDuration: 3600,
						})
						.promise()

					const { Credentials } = await ci
						.getCredentialsForIdentity({
							IdentityId: IdentityId!,
							Logins: {
								['cognito-identity.amazonaws.com']: Token!,
							},
						})
						.promise()

					runner.store[`${prefix}:IdentityId`] = IdentityId
					runner.store[`${prefix}:Token`] = Token
					runner.store[`${prefix}:AccessKeyId`] = Credentials!.AccessKeyId
					runner.store[`${prefix}:SecretKey`] = Credentials!.SecretKey
					runner.store[`${prefix}:SessionToken`] = Credentials!.SessionToken
				}
				return [runner.store[`${prefix}:IdentityId`]]
			},
		},
	]
}
