import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SyncSchedulerService } from '../services/sync-scheduler.service';

export class HcmWebhookDto {
  @ApiProperty({
    description: 'Source identifier from the HCM — logged for audit trail',
    required: false,
    example: 'workday-batch-processor',
  })
  @IsString()
  @IsOptional()
  source?: string;
}

/**
 * SyncController — exposes sync triggers over HTTP.
 *
 * Two endpoints:
 *
 * 1. POST /sync/webhook/hcm-batch
 *    For the HCM to push a "batch update just ran — resync now" notification.
 *    See TRD §4.3 (Out-of-Band Updates) and §8 (Sync Strategy).
 *    In production this would require HMAC signature verification.
 *
 * 2. POST /sync/manual
 *    For ops/engineering to manually trigger a full resync.
 *    Useful during incidents or after HCM maintenance windows.
 */
@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly syncScheduler: SyncSchedulerService) {}

  @Post('webhook/hcm-batch')
  @HttpCode(200)
  @ApiOperation({
    summary: 'HCM webhook — trigger immediate batch sync',
    description:
      'Called by the HCM when a batch balance update has completed. ' +
      'Triggers an immediate full resync so employees see updated balances ' +
      'without waiting for the next cron cycle. ' +
      'Note: In production this endpoint would verify an HMAC signature ' +
      'to ensure the request is genuinely from the HCM.',
  })
  @ApiBody({ type: HcmWebhookDto })
  @ApiResponse({ status: 200, description: 'Sync triggered successfully' })
  @ApiResponse({ status: 503, description: 'HCM unreachable during sync' })
  async handleHcmWebhook(
    @Body() dto: HcmWebhookDto,
  ): Promise<{ updated: number; failed: number }> {
    const triggeredBy = dto.source
      ? `webhook:${dto.source}`
      : 'webhook:unknown';
    return this.syncScheduler.triggerManualSync(triggeredBy);
  }

  @Post('manual')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Manual sync trigger for ops use',
    description:
      'Immediately runs a full batch sync from HCM. Useful after maintenance windows.',
  })
  @ApiResponse({ status: 200, description: 'Sync complete' })
  async triggerManualSync(): Promise<{ updated: number; failed: number }> {
    return this.syncScheduler.triggerManualSync('ops:manual');
  }
}
