import { Type } from 'class-transformer';
import {
  IsBase64,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** https://cloud.google.com/pubsub/docs/push#receive_push */
export class PubSubMessage {
  /** Base64-encoded payload. */
  @IsBase64()
  data: string;

  @IsString()
  @IsNotEmpty()
  messageId: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @IsOptional()
  @IsString()
  publishTime?: string;
}

export class PubSubPushEnvelope {
  @ValidateNested()
  @Type(() => PubSubMessage)
  message: PubSubMessage;

  @IsString()
  subscription: string;

  @IsOptional()
  deliveryAttempt?: number;
}
