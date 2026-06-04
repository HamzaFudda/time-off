import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  HttpCode,
} from '@nestjs/common';
import {
  HcmService,
  DeductionRequest,
  DeductionResponse,
  MockBalance,
} from './hcm.service';

@Controller()
export class HcmController {
  constructor(private readonly hcmService: HcmService) {}

  @Get('balances/batch')
  getBatchBalances(): { balances: MockBalance[] } {
    return this.hcmService.getBatchBalances();
  }

  @Get('balances')
  getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Query('leaveTypeId') leaveTypeId: string,
  ): MockBalance {
    return this.hcmService.getBalance(employeeId, locationId, leaveTypeId);
  }

  @Post('deductions')
  @HttpCode(200)
  processDeduction(@Body() request: DeductionRequest): DeductionResponse {
    return this.hcmService.processDeduction(request);
  }

  @Post('deductions/:transactionId/reverse')
  @HttpCode(200)
  reverseDeduction(@Param('transactionId') transactionId: string): {
    success: boolean;
    message: string;
  } {
    return this.hcmService.reverseDeduction(transactionId);
  }

  @Post('admin/chaos')
  @HttpCode(200)
  setChaosMode(@Body('enabled') enabled: boolean): { status: string } {
    this.hcmService.enableChaosMode(enabled);
    return { status: `Chaos mode ${enabled ? 'enabled' : 'disabled'}` };
  }
}
