import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { TimeOffBalanceService } from '../services/time-off-balance.service';
import { TimeOffBalanceEntity } from '../entities/time-off-balance.entity';

@ApiTags('balances')
@Controller('time-off/balances')
export class TimeOffBalanceController {
  constructor(private readonly balanceService: TimeOffBalanceService) {}

  /**
   * GET /time-off/balances/:employeeId
   *
   * Returns all cached balances for an employee, with staleness flags.
   *
   * Behavior:
   * - Returns the local SQLite cache immediately (fast, available even if HCM is down).
   * - If the cache is stale (older than 4-hour TTL), fires a non-blocking background
   *   refresh. The stale value is still returned in this response.
   * - `isStale: true` in the response signals the UI to show "balance last updated X min ago".
   *
   * This follows the read path described in TRD §4.1 and §8.
   */
  @Get(':employeeId')
  @ApiOperation({
    summary: "Get an employee's leave balances",
    description:
      'Returns cached balances. If stale (>4h old), a background refresh is triggered. ' +
      'The cached value is returned immediately regardless.',
  })
  @ApiParam({
    name: 'employeeId',
    description: 'Employee ID',
    example: 'emp-123',
  })
  @ApiQuery({
    name: 'locationId',
    required: true,
    description: 'HCM location dimension',
  })
  @ApiQuery({
    name: 'leaveTypeId',
    required: true,
    description: 'HCM leave type dimension',
  })
  @ApiResponse({
    status: 200,
    description: 'Balance record with effectiveBalance and isStale flag',
  })
  @ApiResponse({
    status: 404,
    description: 'No balance record found for these dimensions',
  })
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Query('leaveTypeId') leaveTypeId: string,
  ): Promise<{
    balance: TimeOffBalanceEntity;
    effectiveBalance: number;
    isStale: boolean;
  }> {
    return this.balanceService.getBalance(employeeId, locationId, leaveTypeId);
  }
}
