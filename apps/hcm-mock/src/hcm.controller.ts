import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import {
  HcmService,
  BalanceResponse,
  DeductionRequest,
  DeductionResponse,
  BalanceMutationLog,
} from './hcm.service';
import { MutateBalanceDto, SetChaosDto } from './hcm.dto';

@ApiTags('HCM Mock')
@Controller()
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class HcmController {
  constructor(private readonly hcmService: HcmService) {}

  // ─── Balance Reads ──────────────────────────────────────────────────────────

  @Get('balances/batch')
  @ApiOperation({
    summary: 'Get all employee balances (batch pull)',
    description:
      'Returns all balances in one call. Used by the time-off sync cron job.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'All balances with asOfDate timestamp',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Simulated HCM downtime (when chaos mode is enabled)',
  })
  getBatchBalances(): { balances: BalanceResponse[]; asOfDate: string } {
    return this.hcmService.getBatchBalances();
  }

  @Get('balances')
  @ApiOperation({
    summary: 'Get a single employee balance (real-time)',
    description:
      'Point lookup used during the pre-flight check before a manager approves a request.',
  })
  @ApiQuery({ name: 'employeeId', required: true, example: 'emp-123' })
  @ApiQuery({ name: 'locationId', required: true, example: 'loc-us' })
  @ApiQuery({ name: 'leaveTypeId', required: true, example: 'VACATION' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Balance found' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Dimensions not found in HCM',
  })
  getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Query('leaveTypeId') leaveTypeId: string,
  ): BalanceResponse {
    return this.hcmService.getBalance(employeeId, locationId, leaveTypeId);
  }

  // ─── Deductions ─────────────────────────────────────────────────────────────

  @Post('deductions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a leave deduction',
    description: `
      The core write operation. This endpoint is idempotent:
      - If the same transactionId is submitted twice, the HCM returns the
        cached response from the first call. No double deduction occurs.
      - On insufficient balance, returns success=false (not a 4xx/5xx).
    `,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Deduction processed (check success field)',
  })
  processDeduction(@Body() request: DeductionRequest): DeductionResponse {
    return this.hcmService.processDeduction(request);
  }

  @Post('deductions/:transactionId/reverse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reverse a submitted deduction',
    description:
      'Called when an employee cancels an approved request. The HCM acknowledges the reversal.',
  })
  @ApiParam({ name: 'transactionId', example: 'a1b2c3d4-...' })
  reverseDeduction(@Param('transactionId') transactionId: string): {
    success: boolean;
    message: string;
  } {
    return this.hcmService.reverseDeduction(transactionId);
  }

  // ─── Admin / Test Control ───────────────────────────────────────────────────

  @Patch('admin/balances')
  @ApiOperation({
    summary: '[TEST CONTROL] Mutate a balance out-of-band',
    description: `
      Simulates HCM-side balance changes that happen independently of our service:
      - Work anniversary bonus
      - HR manual correction
      - Policy carry-over applied by an HCM batch job

      This is the key endpoint for testing our service's sync/staleness detection.
      Change a balance here, then observe whether the time-off service detects the
      divergence and reconciles it on the next sync cycle.
    `,
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Balance mutated' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Dimensions not found',
  })
  mutateBalance(@Body() dto: MutateBalanceDto): BalanceResponse {
    return this.hcmService.mutateBalance(
      dto.employeeId,
      dto.locationId,
      dto.leaveTypeId,
      dto.newAvailableDays,
      dto.reason,
    );
  }

  @Get('admin/mutation-log')
  @ApiOperation({
    summary: '[TEST CONTROL] Get the out-of-band mutation audit log',
    description:
      'Returns all balance mutations made via PATCH /admin/balances since startup.',
  })
  getMutationLog(): BalanceMutationLog[] {
    return this.hcmService.getMutationLog();
  }

  @Post('admin/chaos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[TEST CONTROL] Configure chaos mode',
    description: `
      Enables/disables random 500 errors on all endpoints.
      Use to test exponential backoff and idempotency in the time-off service.
      failureProbability (0.0–1.0) controls how often failures occur.
    `,
  })
  setChaosMode(@Body() dto: SetChaosDto): { status: string } {
    this.hcmService.setChaosMode(dto.enabled);
    return { status: `Chaos mode ${dto.enabled ? 'enabled' : 'disabled'}` };
  }
}
